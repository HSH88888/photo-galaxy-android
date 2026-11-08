'use strict';
/* Photo Galaxy — zoomable radial (balloon) tree of folders, photos packed around their folder.
 *
 * World units: a photo has radius P = 1. Camera maps world -> screen: sx = x * s + tx.
 * Data from /api/tree: folders[i] = [parent, name, photoStart, photoCount, subtreeTotal]
 * (folders in DFS pre-order, each folder's photos are a contiguous id range).
 */

const $ = (q) => document.querySelector(q);
const canvas = $('#c');
const ctx = canvas.getContext('2d');

const COLORS = ['#6c5ce7', '#e74c3c', '#f39c12', '#27ae60', '#3498db', '#e84393', '#00b894', '#fdcb6e', '#a29bfe', '#fd79a8'];
const P = 1;                       // photo radius
const AREA = 2.35 * 2.35;          // world area reserved per photo
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const LEVEL_SIZE = [160, 512, 1600];      // thumb / medium / large (px, square crop)
const LEVEL_CAP = [3000, 160, 16];        // max cached images per level
const MAX_INFLIGHT = 8;
let thumbMaxVisible = Math.max(10, Math.min(1000, +(localStorage.getItem('thumbMaxVisible') || 130)));

let W = 0, H = 0, DPR = 1;
let T = null;            // tree json
let N = 0, NP = 0;       // folder / photo counts
let parent, start, count, total, depth, rep, children;
let fx, fy, dir, repR, r0, coreR, subR, dist, span, encX, encY;
let px, py, pf;
const cam = { s: 1, tx: 0, ty: 0 };
let minScale = 0.001;

/* ------------------------------------------------------------------ data */

async function loadTree() {
  for (;;) {
    try {
      const r = await fetch('/api/tree', { cache: 'no-store' });
      if (r.ok) { T = await r.json(); break; }
    } catch (e) { /* server starting */ }
    $('#stats').textContent = '폴더 스캔 중...';
    await new Promise((res) => setTimeout(res, 1000));
  }
  layout();
  if (T.mode) updateModeButtons(T.mode);
  const unitLabel = T.mode === 'month' ? '연·월 그룹' : T.mode === 'day' ? '일별 그룹' : '폴더';
  const withPhotos = count.reduce((a, c) => a + (c > 0 ? 1 : 0), 0);
  $('#stats').textContent = `${T.root}  ·  ${unitLabel} ${withPhotos.toLocaleString()}개  ·  사진 ${NP.toLocaleString()}장`;
  fitAll(false);
}

function layout() {
  const fl = T.folders;
  N = fl.length; NP = T.photos.length;
  parent = new Int32Array(N); start = new Int32Array(N); count = new Int32Array(N);
  total = new Int32Array(N); depth = new Int32Array(N); rep = new Int32Array(N).fill(-1);
  children = Array.from({ length: N }, () => []);
  for (let i = 0; i < N; i++) {
    const [p, , st, c, t] = fl[i];
    parent[i] = p; start[i] = st; count[i] = c; total[i] = t;
    if (p >= 0) { children[p].push(i); depth[i] = depth[p] + 1; }
  }
  // representative photo: first photo of the folder, else of the first child that has one
  for (let i = N - 1; i >= 0; i--) {
    if (count[i] > 0) rep[i] = start[i];
    else for (const c of children[i]) if (rep[c] >= 0) { rep[i] = rep[c]; break; }
  }

  fx = new Float64Array(N); fy = new Float64Array(N); dir = new Float64Array(N);
  repR = new Float64Array(N); r0 = new Float64Array(N); coreR = new Float64Array(N);
  subR = new Float64Array(N); dist = new Float64Array(N); span = new Float64Array(N);
  encX = new Float64Array(N); encY = new Float64Array(N);
  // local frame of each folder: folder at origin, children fan out around +x
  const lx = new Float64Array(N), ly = new Float64Array(N), lang = new Float64Array(N);
  const ox = new Float64Array(N), oy = new Float64Array(N);   // enclosing-circle center (local)
  const ROOT_SPAN = Math.PI * 2 * 0.985, SUB_SPAN = Math.PI * 1.25;

  // bottom-up: each subtree is laid out in its own frame and wrapped by an enclosing circle
  for (let i = N - 1; i >= 0; i--) {
    repR[i] = 3 + 2.4 * Math.pow(total[i], 0.45);          // folder photo grows with photo count
    r0[i] = repR[i] + 1.6;
    coreR[i] = count[i] > 0 ? Math.sqrt(r0[i] * r0[i] + count[i] * AREA / Math.PI) + 1.2 : repR[i] + 1;
    const ch = children[i];
    if (!ch.length) { subR[i] = coreR[i]; continue; }
    const Rs = ch.map((c) => subR[c] + 1.5 + 0.02 * subR[c]);
    let maxR = 0, sumR = 0;
    for (const r of Rs) { if (r > maxR) maxR = r; sumR += r; }
    const maxSpan = i === 0 ? ROOT_SPAN : SUB_SPAN;
    let d = Math.max(coreR[i] + maxR + 3 + 0.1 * coreR[i], 2 * sumR / maxSpan);
    let sp = 0;
    for (let it = 0; it < 600; it++) {
      sp = 0;
      for (const r of Rs) sp += 2 * Math.asin(Math.min(1, r / d));
      if (sp <= maxSpan) break;
      d *= 1.02;
    }
    dist[i] = d; span[i] = sp;
    const target = i === 0 ? Math.PI * 2 : Math.min(maxSpan, sp * 1.15);
    const k = target / sp;
    let a = i === 0 ? -Math.PI / 2 : -target / 2;
    let x0 = -coreR[i], x1 = coreR[i], y0 = -coreR[i], y1 = coreR[i];
    const ecs = [];
    ch.forEach((c, n) => {
      const th = 2 * Math.asin(Math.min(1, Rs[n] / d)) * k, ac = a + th / 2;
      const ca = Math.cos(ac), sa = Math.sin(ac);
      const ex = d * ca, ey = d * sa;              // child's enclosing circle center
      lx[c] = ex - (ca * ox[c] - sa * oy[c]);
      ly[c] = ey - (sa * ox[c] + ca * oy[c]);
      lang[c] = ac;
      ecs.push([ex, ey, subR[c]]);
      x0 = Math.min(x0, ex - subR[c]); x1 = Math.max(x1, ex + subR[c]);
      y0 = Math.min(y0, ey - subR[c]); y1 = Math.max(y1, ey + subR[c]);
      a += th;
    });
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    let R = Math.hypot(cx, cy) + coreR[i];
    for (const [ex, ey, r] of ecs) R = Math.max(R, Math.hypot(ex - cx, ey - cy) + r);
    ox[i] = cx; oy[i] = cy; subR[i] = R;
  }

  // top-down: absolute positions/rotations
  dir[0] = 0;
  for (let i = 0; i < N; i++) {
    const c0 = Math.cos(dir[i]), s0 = Math.sin(dir[i]);
    encX[i] = fx[i] + c0 * ox[i] - s0 * oy[i];
    encY[i] = fy[i] + s0 * ox[i] + c0 * oy[i];
    for (const c of children[i]) {
      fx[c] = fx[i] + c0 * lx[c] - s0 * ly[c];
      fy[c] = fy[i] + s0 * lx[c] + c0 * ly[c];
      dir[c] = dir[i] + lang[c];
    }
  }

  // photos: sunflower spiral in the ring around their folder's photo
  px = new Float64Array(NP); py = new Float64Array(NP); pf = new Int32Array(NP);
  for (let i = 0; i < N; i++) {
    const rr = r0[i] * r0[i];
    for (let k = 0; k < count[i]; k++) {
      const id = start[i] + k;
      const r = Math.sqrt(rr + (k + 0.5) * AREA / Math.PI);
      const a = k * GOLDEN + dir[i];
      px[id] = fx[i] + r * Math.cos(a);
      py[id] = fy[i] + r * Math.sin(a);
      pf[id] = i;
    }
  }
}

function folderPath(i) {
  const parts = [];
  for (; i > 0; i = parent[i]) parts.push(T.folders[i][1]);
  return parts.reverse().join(' › ') || T.rootName;
}

/* ---------------------------------------------------------------- images */

const cache = new Map();   // key -> {st: 0 loading | 1 ok | 2 err, img, t, lvl}
const levelCount = [0, 0, 0];
let inflight = 0, frame = 0;

function key(id, lvl) { return id * 4 + lvl; }

function desiredLevel(sizePx) {
  const d = sizePx * DPR;
  if (d < 9) return -1;
  if (d <= 190) return 0;
  if (d <= 620) return 1;
  return 2;
}

/** Best available image for photo `id` (<= lvl); queues the wanted level. */
function getImg(id, lvl, pri, wanted) {
  let best = null;
  for (let l = lvl; l >= 0; l--) {
    const e = cache.get(key(id, l));
    if (e && e.st === 1) { e.t = frame; best = e.img; break; }
  }
  const want = cache.get(key(id, lvl));
  if (!want) wanted.push({ id, lvl, pri });
  else if (want.st === 0) want.t = frame;
  return best;
}

async function fetchImg(id, lvl) {
  const v = T.version || 0;
  const url = lvl === 0 ? `/api/thumb?id=${id}&v=${v}` : `/api/img?id=${id}&s=${LEVEL_SIZE[lvl]}&v=${v}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(r.status);
  const bmp = await createImageBitmap(await r.blob());
  const side = Math.min(bmp.width, bmp.height);
  const sz = Math.max(1, Math.min(side, LEVEL_SIZE[lvl]));
  const c = document.createElement('canvas');
  c.width = c.height = sz;
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.beginPath(); g.arc(sz / 2, sz / 2, sz / 2, 0, Math.PI * 2); g.clip();
  g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, sz, sz);
  bmp.close();
  return c;
}

function pump(wanted) {
  if (inflight >= MAX_INFLIGHT || !wanted.length) return;
  wanted.sort((a, b) => b.pri - a.pri);
  for (const w of wanted) {
    if (inflight >= MAX_INFLIGHT) break;
    const k = key(w.id, w.lvl);
    if (cache.has(k)) continue;
    const e = { st: 0, img: null, t: frame, lvl: w.lvl };
    cache.set(k, e);
    inflight++;
    fetchImg(w.id, w.lvl)
      .then((img) => { e.img = img; e.st = 1; levelCount[w.lvl]++; evict(w.lvl); })
      .catch(() => { e.st = 2; })
      .finally(() => { inflight--; requestRender(); });
  }
}

function evict(lvl) {
  if (levelCount[lvl] <= LEVEL_CAP[lvl] * 1.1) return;
  const list = [];
  for (const [k, e] of cache) if (e.lvl === lvl && e.st === 1 && e.t < frame) list.push([k, e.t]);
  list.sort((a, b) => a[1] - b[1]);
  const drop = levelCount[lvl] - LEVEL_CAP[lvl];
  for (let j = 0; j < drop && j < list.length; j++) { cache.delete(list[j][0]); levelCount[lvl]--; }
}

/* ---------------------------------------------------------------- render */

let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function resize() {
  DPR = window.devicePixelRatio || 1;
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
  requestRender();
}

function drawCircleImg(img, x, y, r) { ctx.drawImage(img, x - r, y - r, r * 2, r * 2); }

function render() {
  frame++;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = '#0d0d17';
  ctx.fillRect(0, 0, W, H);
  if (!T) return;
  ctx.imageSmoothingQuality = 'medium';
  const { s, tx, ty } = cam;
  const wanted = [];
  const cx = W / 2, cy = H / 2;
  const inView = (x, y, r) => x + r > 0 && x - r < W && y + r > 0 && y - r < H;

  // edges
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(124,108,255,0.38)';
  ctx.beginPath();
  for (let i = 1; i < N; i++) {
    const p = parent[i];
    const x0 = fx[p] * s + tx, y0 = fy[p] * s + ty, x1 = fx[i] * s + tx, y1 = fy[i] * s + ty;
    const da = p === 0 ? dir[i] : dir[p];
    const qx = (fx[p] + Math.cos(da) * dist[p] * 0.5) * s + tx, qy = (fy[p] + Math.sin(da) * dist[p] * 0.5) * s + ty;
    if (Math.max(x0, x1, qx) < 0 || Math.min(x0, x1, qx) > W || Math.max(y0, y1, qy) < 0 || Math.min(y0, y1, qy) > H) continue;
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(qx, qy, x1, y1);
  }
  ctx.stroke();

  // photos around folders
  const pr = P * s;
  const rawPlvl = desiredLevel(pr * 2);
  let visPhotos = 0;
  if (rawPlvl >= 0 && pr >= 0.6) {
    for (let i = 0; i < N && visPhotos <= thumbMaxVisible; i++) {
      if (!count[i]) continue;
      const x = fx[i] * s + tx, y = fy[i] * s + ty;
      if (!inView(x, y, coreR[i] * s)) continue;
      const a = start[i], b = a + count[i];
      for (let id = a; id < b; id++) {
        const sx = px[id] * s + tx, sy = py[id] * s + ty;
        if (sx >= -pr && sx <= W + pr && sy >= -pr && sy <= H + pr) {
          if (++visPhotos > thumbMaxVisible) break;
        }
      }
    }
  }
  const plvl = visPhotos <= thumbMaxVisible ? rawPlvl : -1;

  for (let i = 0; i < N; i++) {
    if (!count[i]) continue;
    const x = fx[i] * s + tx, y = fy[i] * s + ty;
    if (!inView(x, y, coreR[i] * s)) continue;
    const col = COLORS[(depth[i] + 1) % COLORS.length];
    if (pr < 0.6) {                       // too small: draw the photo ring as a soft halo
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(x, y, coreR[i] * s, 0, Math.PI * 2);
      ctx.arc(x, y, r0[i] * s, 0, Math.PI * 2, true);
      ctx.fill();
      ctx.globalAlpha = 1;
      continue;
    }
    ctx.fillStyle = col;
    const a = start[i], b = a + count[i];
    if (plvl < 0) {
      ctx.beginPath();
      for (let id = a; id < b; id++) {
        const sx = px[id] * s + tx, sy = py[id] * s + ty;
        if (sx < -pr || sx > W + pr || sy < -pr || sy > H + pr) continue;
        if (pr < 2.2) {
          ctx.rect(sx - pr, sy - pr, pr * 2, pr * 2);
        } else {
          ctx.moveTo(sx + pr, sy);
          ctx.arc(sx, sy, pr, 0, Math.PI * 2);
        }
      }
      ctx.fill();
    } else {
      for (let id = a; id < b; id++) {
        const sx = px[id] * s + tx, sy = py[id] * s + ty;
        if (sx < -pr || sx > W + pr || sy < -pr || sy > H + pr) continue;
        const pri = pr - Math.hypot(sx - cx, sy - cy) * 0.001;
        const img = getImg(id, plvl, pri, wanted);
        if (img) drawCircleImg(img, sx, sy, pr);
        else { ctx.beginPath(); ctx.arc(sx, sy, pr, 0, Math.PI * 2); ctx.fill(); }
      }
    }
  }

  // folder photos (representative image, size by photo count)
  const labels = [];
  for (let i = 0; i < N; i++) {
    const x = fx[i] * s + tx, y = fy[i] * s + ty;
    const rr = Math.max(1.6, repR[i] * s);
    if (!inView(x, y, rr + 40)) continue;
    const col = COLORS[depth[i] % COLORS.length];
    const lvl = rep[i] >= 0 ? desiredLevel(rr * 2) : -1;
    const img = lvl >= 0 ? getImg(rep[i], lvl, rr * 2 + 1000, wanted) : null;
    if (img) {
      drawCircleImg(img, x, y, rr);
      ctx.lineWidth = Math.max(1.5, Math.min(5, rr * 0.05));
      ctx.strokeStyle = col;
      ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.stroke();
    } else {
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.fill();
    }
    if (i === hoverFolder) {
      ctx.lineWidth = 2.5; ctx.strokeStyle = '#fff';
      ctx.beginPath(); ctx.arc(x, y, rr + 2, 0, Math.PI * 2); ctx.stroke();
    }
    if (rr >= 8 || (depth[i] === 1 && rr >= 5.5)) labels.push([i, x, y, rr]);
  }

  // labels
  ctx.textAlign = 'center';
  ctx.lineJoin = 'round';
  for (const [i, x, y, rr] of labels) {
    const fs = Math.max(9.5, Math.min(18, rr * 0.45));
    let name = T.folders[i][1];
    if (name.length > 22) name = name.slice(0, 21) + '…';
    const ly = y + rr + fs + 3;
    ctx.font = `600 ${fs}px "Segoe UI","Malgun Gothic",sans-serif`;
    ctx.lineWidth = 3.5; ctx.strokeStyle = '#0d0d17';
    ctx.strokeText(name, x, ly);
    ctx.fillStyle = '#fff';
    ctx.fillText(name, x, ly);
    ctx.font = `${fs * 0.78}px "Segoe UI","Malgun Gothic",sans-serif`;
    const sub = `${total[i].toLocaleString()}장`;
    ctx.strokeText(sub, x, ly + fs);
    ctx.fillStyle = '#a8a8c8';
    ctx.fillText(sub, x, ly + fs);
  }

  pump(wanted);
  if (anim) requestRender();
}

/* ---------------------------------------------------------------- camera */

let anim = null;

function setCamera(wcx, wcy, s) {
  cam.s = s; cam.tx = W / 2 - wcx * s; cam.ty = H / 2 - wcy * s;
}

function flyTo(wx, wy, radius, animate = true) {
  const s1 = Math.max(minScale, Math.min(400, Math.min(W, H) / (2 * radius * 1.08)));
  if (!animate) { setCamera(wx, wy, s1); requestRender(); return; }
  const s0 = cam.s, c0x = (W / 2 - cam.tx) / s0, c0y = (H / 2 - cam.ty) / s0;
  const t0 = performance.now(), dur = 750;
  anim = (now) => {
    let u = Math.min(1, (now - t0) / dur);
    u = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
    const s = Math.exp(Math.log(s0) + (Math.log(s1) - Math.log(s0)) * u);
    setCamera(c0x + (wx - c0x) * u, c0y + (wy - c0y) * u, s);
    if (u >= 1) anim = null;
  };
  requestRender();
}

function stepAnim(now) { if (anim) { anim(now); requestRender(); } requestAnimationFrame(stepAnim); }
requestAnimationFrame(stepAnim);

function fitAll(animate = true) {
  if (!T) return;
  minScale = Math.min(W, H) / (2 * subR[0]) * 0.4;
  flyTo(encX[0], encY[0], subR[0], animate);
}

function zoomAt(x, y, f) {
  const s2 = Math.max(minScale, Math.min(400, cam.s * f));
  f = s2 / cam.s;
  cam.tx = x - (x - cam.tx) * f;
  cam.ty = y - (y - cam.ty) * f;
  cam.s = s2;
  requestRender();
}

/* ------------------------------------------------------------ hit testing */

function hitTest(x, y) {
  if (!T) return null;
  const wx = (x - cam.tx) / cam.s, wy = (y - cam.ty) / cam.s;
  const minR = 14 / cam.s;
  let folder = -1, fr = Infinity;
  for (let i = 0; i < N; i++) {
    const r = Math.max(repR[i], minR);
    const dx = wx - fx[i], dy = wy - fy[i];
    if (dx * dx + dy * dy <= r * r && r < fr) { folder = i; fr = r; }
  }
  if (folder >= 0) return { type: 'folder', i: folder };
  for (let i = 0; i < N; i++) {
    if (!count[i]) continue;
    const dx = wx - fx[i], dy = wy - fy[i], d2 = dx * dx + dy * dy;
    if (d2 > coreR[i] * coreR[i]) continue;
    if (P * cam.s >= 2) {
      let best = -1, bd = (P * 1.25) ** 2;
      for (let id = start[i], e = id + count[i]; id < e; id++) {
        const ex = wx - px[id], ey = wy - py[id], dd = ex * ex + ey * ey;
        if (dd < bd) { bd = dd; best = id; }
      }
      if (best >= 0) return { type: 'photo', id: best };
    }
    return { type: 'ring', i };
  }
  return null;
}

/* ------------------------------------------------------------ interaction */

let drag = null, pinch = null, hoverFolder = -1, lastTap = { t: 0, x: 0, y: 0 };
const pointers = new Map();
const tip = $('#tip');

function syncGestureState() {
  const pts = [...pointers.values()];
  if (pts.length === 1) {
    pinch = null;
    drag = { x: pts[0].x, y: pts[0].y, tx: cam.tx, ty: cam.ty, moved: drag ? drag.moved : false };
  } else if (pts.length >= 2) {
    const [a, b] = pts;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const dist = Math.max(8, Math.hypot(a.x - b.x, a.y - b.y));
    pinch = { mx, my, dist, s: cam.s, wx: (mx - cam.tx) / cam.s, wy: (my - cam.ty) / cam.s };
    if (drag) drag.moved = true;
    tip.hidden = true;
  } else {
    drag = null;
    pinch = null;
  }
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') $('#help').textContent = '두 손가락: 확대/축소 · 한 손가락 드래그: 이동 · 탭: 폴더/사진 열기 · 더블탭: 확대';
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
  anim = null;
  try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  syncGestureState();
});

canvas.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    if (pointers.size >= 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const d = Math.max(8, Math.hypot(a.x - b.x, a.y - b.y));
      const s2 = Math.max(minScale, Math.min(400, pinch.s * (d / pinch.dist)));
      cam.s = s2;
      cam.tx = mx - pinch.wx * s2;
      cam.ty = my - pinch.wy * s2;
      requestRender();
      return;
    }
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      const thresh = e.pointerType === 'touch' ? 8 : 4;
      if (!drag.moved && Math.hypot(dx, dy) > thresh) {
        drag.moved = true;
        canvas.classList.add('dragging');
        tip.hidden = true;
      }
      if (drag.moved) {
        cam.tx = drag.tx + dx;
        cam.ty = drag.ty + dy;
        requestRender();
      }
      return;
    }
  }
  if (e.pointerType !== 'touch') hover(e.clientX, e.clientY);
});

function onPointerEnd(e) {
  const wasSingleTap = pointers.size === 1 && drag && !drag.moved;
  pointers.delete(e.pointerId);
  canvas.classList.remove('dragging');
  if (wasSingleTap) {
    const now = performance.now();
    if (e.pointerType === 'touch' && now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 32) {
      lastTap.t = 0;
      zoomAt(e.clientX, e.clientY, 2.2);
    } else {
      lastTap = { t: now, x: e.clientX, y: e.clientY };
      click(e.clientX, e.clientY);
    }
  }
  syncGestureState();
}

canvas.addEventListener('pointerup', onPointerEnd);
canvas.addEventListener('pointercancel', onPointerEnd);
canvas.addEventListener('pointerleave', (e) => {
  if (!pointers.has(e.pointerId)) { tip.hidden = true; setHover(-1); }
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  anim = null;
  const k = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 1 : 0.0016;
  zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * k));
}, { passive: false });

function setHover(i) { if (i !== hoverFolder) { hoverFolder = i; requestRender(); } }

function hover(x, y) {
  const h = hitTest(x, y);
  canvas.classList.toggle('pointer', !!h);
  if (!h) { tip.hidden = true; setHover(-1); return; }
  let html;
  if (h.type === 'photo') {
    const i = pf[h.id];
    html = `<b>${esc(T.photos[h.id])}</b><br><span>${esc(folderPath(i))} · ${h.id - start[i] + 1}/${count[i]}</span>`;
    setHover(-1);
  } else {
    const i = h.i;
    html = `<b>${esc(T.folders[i][1])}</b><br><span>${esc(folderPath(i))}</span><br>` +
      `<span>사진 ${total[i].toLocaleString()}장` + (count[i] !== total[i] ? ` (이 폴더 ${count[i].toLocaleString()}장)` : '') + `</span>`;
    setHover(i);
  }
  tip.innerHTML = html;
  tip.hidden = false;
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  tip.style.left = Math.min(W - tw - 8, x + 14) + 'px';
  tip.style.top = Math.min(H - th - 8, y + 16) + 'px';
}

function click(x, y) {
  const h = hitTest(x, y);
  if (!h) return;
  if (h.type === 'photo') return openViewer(h.id);
  const i = h.i;
  const r = count[i] > 0 ? coreR[i] : subR[i];
  const fill = r * cam.s * 2 / Math.min(W, H);
  if (h.type === 'folder' && fill > 0.75 && rep[i] >= 0) return openViewer(rep[i]);
  flyTo(count[i] > 0 ? fx[i] : encX[i], count[i] > 0 ? fy[i] : encY[i], r);
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* ---------------------------------------------------------------- viewer */

const viewer = $('#viewer'), vimg = $('#vimg');
let vid = -1;
const preload = [];

function viewSize() { return Math.min(4096, Math.round(Math.max(W, H) * DPR)); }
function bigUrl(id) { return `/api/img?id=${id}&s=${viewSize()}&v=${T.version || 0}`; }

function openViewer(id) {
  if (id < 0 || id >= NP) return;
  vid = id;
  viewer.hidden = false;
  tip.hidden = true;
  const v = T.version || 0;
  vimg.src = `/api/thumb?id=${id}&v=${v}`;
  const hi = new Image();
  hi.onload = () => { if (vid === id) vimg.src = hi.src; };
  hi.src = bigUrl(id);
  const i = pf[id];
  $('#vinfo').innerHTML = `<b>${esc(T.photos[id])}</b> &nbsp; ${esc(folderPath(i))} &nbsp; (${id - start[i] + 1} / ${count[i]})`;
  $('#vorig').href = `/api/orig?id=${id}&v=${v}`;
  preload.length = 0;
  for (const n of [id + 1, id - 1]) if (n >= 0 && n < NP) { const im = new Image(); im.src = bigUrl(n); preload.push(im); }
}

function closeViewer() {
  viewer.hidden = true;
  if (vid >= 0) {   // keep the map in sync with the photo you ended on
    const sx = px[vid] * cam.s + cam.tx, sy = py[vid] * cam.s + cam.ty;
    if (sx < 0 || sx > W || sy < 0 || sy > H) flyTo(px[vid], py[vid], Math.min(W, H) / (2 * cam.s * 1.08));
  }
  vid = -1;
}

$('#vprev').onclick = (e) => { e.stopPropagation(); openViewer(vid - 1); };
$('#vnext').onclick = (e) => { e.stopPropagation(); openViewer(vid + 1); };
$('#vclose').onclick = (e) => { e.stopPropagation(); closeViewer(); };
$('#vorig').onclick = (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (vid >= 0) fetch(`/api/open-file?id=${vid}`);
};
viewer.addEventListener('click', (e) => { if (e.target === viewer) closeViewer(); });
viewer.addEventListener('wheel', (e) => { e.preventDefault(); openViewer(vid + (e.deltaY > 0 ? 1 : -1)); }, { passive: false });

let vTouch = null;
viewer.addEventListener('touchstart', (e) => {
  if (e.touches.length === 1) {
    vTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: performance.now() };
  } else {
    vTouch = null;
  }
}, { passive: true });
viewer.addEventListener('touchend', (e) => {
  if (!vTouch || !e.changedTouches.length) return;
  const dx = e.changedTouches[0].clientX - vTouch.x;
  const dy = e.changedTouches[0].clientY - vTouch.y;
  vTouch = null;
  if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.3) {
    openViewer(vid + (dx < 0 ? 1 : -1));
  } else if (dy > 80 && Math.abs(dy) > Math.abs(dx) * 1.5) {
    closeViewer();
  }
}, { passive: true });

window.addEventListener('keydown', (e) => {
  if (!viewer.hidden) {
    if (e.key === 'ArrowRight' || e.key === ' ') openViewer(vid + 1);
    else if (e.key === 'ArrowLeft') openViewer(vid - 1);
    else if (e.key === 'Escape') closeViewer();
    else return;
    e.preventDefault();
    return;
  }
  if (document.activeElement === $('#search')) return;
  if (e.key === 'Home' || e.key === '0') fitAll();
  else if (e.key === '+' || e.key === '=') zoomAt(W / 2, H / 2, 1.5);
  else if (e.key === '-') zoomAt(W / 2, H / 2, 1 / 1.5);
});

/* ---------------------------------------------------------------- search */

const search = $('#search'), results = $('#results');
let hits = [], sel = 0;

function renderResults() {
  results.innerHTML = hits.map((i, k) =>
    `<li data-i="${i}" class="${k === sel ? 'sel' : ''}">${esc(T.folders[i][1])} <span style="color:#8a8aa5">· ${total[i].toLocaleString()}장</span>` +
    `<span class="p">${esc(folderPath(i))}</span></li>`).join('');
  results.hidden = !hits.length;
}

search.addEventListener('input', () => {
  const q = search.value.trim().toLowerCase();
  hits = [];
  sel = 0;
  if (q && T) {
    for (let i = 0; i < N && hits.length < 40; i++) if (T.folders[i][1].toLowerCase().includes(q)) hits.push(i);
  }
  renderResults();
});

search.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { sel = Math.min(hits.length - 1, sel + 1); renderResults(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); renderResults(); e.preventDefault(); }
  else if (e.key === 'Enter' && hits.length) goFolder(hits[sel]);
  else if (e.key === 'Escape') { search.value = ''; hits = []; renderResults(); search.blur(); }
});

results.addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (li) goFolder(+li.dataset.i);
});

function goFolder(i) {
  results.hidden = true;
  search.blur();
  flyTo(count[i] > 0 ? fx[i] : encX[i], count[i] > 0 ? fy[i] : encY[i], count[i] > 0 ? coreR[i] : subR[i]);
}

/* ------------------------------------------------------------------ misc */

async function waitForScanAndReload() {
  for (;;) {
    await new Promise((r) => setTimeout(r, 400));
    try { const st = await (await fetch('/api/status')).json(); if (!st.scanning) break; } catch (e) { /* retry */ }
  }
  cache.clear(); levelCount.fill(0);
  await loadTree();
}

function updateModeButtons(mode) {
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
}

$('#modeGroup').addEventListener('click', async (e) => {
  const btn = e.target.closest('.mode-btn');
  if (!btn || btn.classList.contains('active')) return;
  const mode = btn.dataset.mode;
  updateModeButtons(mode);
  $('#stats').textContent = '분류 기준 변경 중...';
  await fetch(`/api/set-mode?mode=${encodeURIComponent(mode)}`);
  await waitForScanAndReload();
});

function setThumbMax(val) {
  thumbMaxVisible = Math.max(10, Math.min(1000, Math.round(val / 10) * 10));
  try { localStorage.setItem('thumbMaxVisible', String(thumbMaxVisible)); } catch (_) {}
  $('#thumbVal').textContent = thumbMaxVisible;
  $('#tpCur').textContent = thumbMaxVisible;
  $('#tpRange').value = thumbMaxVisible;
  requestRender();
}
setThumbMax(thumbMaxVisible);

$('#btnThumbCfg').onclick = (e) => {
  e.stopPropagation();
  $('#thumbPop').hidden = !$('#thumbPop').hidden;
};
$('#thumbPop').onclick = (e) => e.stopPropagation();
$('#tpRange').oninput = (e) => setThumbMax(+e.target.value);
$('#tpMinus').onclick = () => setThumbMax(thumbMaxVisible - 10);
$('#tpPlus').onclick = () => setThumbMax(thumbMaxVisible + 10);
document.querySelectorAll('.tp-presets button').forEach((b) => {
  b.onclick = () => { setThumbMax(+b.dataset.v); $('#thumbPop').hidden = true; };
});
window.addEventListener('pointerdown', (e) => {
  if (!$('#thumbPop').hidden && !e.target.closest('.thumb-wrap')) $('#thumbPop').hidden = true;
});

$('#btnFit').onclick = () => fitAll();
$('#btnFolder').onclick = async () => {
  const b = $('#btnFolder');
  b.disabled = true;
  try {
    const res = await (await fetch('/api/pick-folder', { method: 'POST' })).json();
    if (res.changed) {
      $('#stats').textContent = `${res.root} 스캔 중...`;
      await waitForScanAndReload();
    }
  } finally {
    b.disabled = false;
  }
};
$('#btnRescan').onclick = async () => {
  const b = $('#btnRescan');
  b.disabled = true; b.textContent = '스캔 중...';
  await fetch('/api/rescan');
  await waitForScanAndReload();
  b.disabled = false; b.textContent = '새로고침';
};

window.__handleAndroidBack = () => {
  if (!viewer.hidden) { closeViewer(); return true; }
  if (!results.hidden) { results.hidden = true; search.blur(); return true; }
  return false;
};

window.addEventListener('resize', resize);
resize();
loadTree();
