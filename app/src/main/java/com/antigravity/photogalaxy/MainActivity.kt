package com.antigravity.photogalaxy

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.io.ByteArrayInputStream
import java.text.NumberFormat
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private val scanning = AtomicBoolean(false)
    @Volatile
    private var scanResult: ScanResult? = null
    @Volatile
    private var currentPrefix: String = ""
    @Volatile
    private var currentMode: String = "month"

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) {
        startScanAsync()
        webView.evaluateJavascript("if (window.loadTree) loadTree();", null)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, true)

        val prefs = getSharedPreferences("photo_galaxy", MODE_PRIVATE)
        currentPrefix = prefs.getString("root_prefix", "") ?: ""
        currentMode = prefs.getString("view_mode", "month") ?: "month"

        webView = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#0D0D17"))
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                builtInZoomControls = false
                displayZoomControls = false
                useWideViewPort = true
                loadWithOverviewMode = true
                cacheMode = WebSettings.LOAD_DEFAULT
            }
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest
                ): WebResourceResponse? {
                    val url = request.url
                    if (url.host != "appassets.androidplatform.net") {
                        return super.shouldInterceptRequest(view, request)
                    }
                    return handleLocalRequest(url)
                }
            }
        }
        ViewCompat.setOnApplyWindowInsetsListener(webView) { v, insets ->
            val sys = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            v.setPadding(sys.left, sys.top, sys.right, sys.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(webView)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript("window.__handleAndroidBack ? window.__handleAndroidBack() : false") { res ->
                    if (res != "true") {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                        isEnabled = true
                    }
                }
            }
        })

        ensurePermissionsAndLoad()
        webView.loadUrl("https://appassets.androidplatform.net/index.html")
    }

    private fun requiredPermissions(): Array<String> {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            arrayOf(Manifest.permission.READ_MEDIA_IMAGES)
        } else {
            arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
    }

    private fun hasPermissions(): Boolean {
        return requiredPermissions().all {
            ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
        }
    }

    private fun ensurePermissionsAndLoad() {
        if (hasPermissions()) {
            startScanAsync()
        } else {
            permissionLauncher.launch(requiredPermissions())
        }
    }

    private fun startScanAsync() {
        if (!scanning.compareAndSet(false, true)) return
        thread(isDaemon = true) {
            try {
                scanResult = PhotoScanner.scanAndBuildTree(applicationContext, currentPrefix, currentMode)
            } finally {
                scanning.set(false)
            }
        }
    }

    private fun handleLocalRequest(url: Uri): WebResourceResponse {
        val path = url.path ?: "/"
        return when (path) {
            "/api/tree" -> {
                val res = scanResult
                if (res == null || scanning.get()) {
                    jsonResponse("""{"scanning":true}""", 503)
                } else {
                    WebResourceResponse(
                        "application/json",
                        "utf-8",
                        200,
                        "OK",
                        mapOf("Cache-Control" to "no-cache"),
                        ByteArrayInputStream(res.treeJson)
                    )
                }
            }
            "/api/status" -> {
                jsonResponse("""{"scanning":${scanning.get()}}""")
            }
            "/api/rescan" -> {
                startScanAsync()
                jsonResponse("""{"ok":true}""")
            }
            "/api/set-mode" -> {
                val m = url.getQueryParameter("mode") ?: "month"
                if (m in listOf("folder", "month", "day")) {
                    currentMode = m
                    getSharedPreferences("photo_galaxy", MODE_PRIVATE)
                        .edit()
                        .putString("view_mode", m)
                        .apply()
                    scanResult = null
                    startScanAsync()
                }
                jsonResponse("""{"ok":true,"mode":${org.json.JSONObject.quote(currentMode)}}""")
            }
            "/api/pick-folder" -> {
                handlePickFolder()
            }
            "/api/thumb", "/api/img" -> {
                val id = url.getQueryParameter("id")?.toIntOrNull() ?: -1
                val uris = scanResult?.uris
                if (uris == null || id !in uris.indices) {
                    return emptyResponse(404)
                }
                val photoUri = uris[id]
                val bytes = if (path == "/api/thumb") {
                    ImageHelper.thumbnail(applicationContext, photoUri)
                } else {
                    val s = (url.getQueryParameter("s")?.toIntOrNull() ?: 1024).coerceIn(64, 4096)
                    ImageHelper.resized(applicationContext, photoUri, s)
                }
                if (bytes == null) {
                    emptyResponse(404)
                } else {
                    WebResourceResponse(
                        "image/jpeg",
                        null,
                        200,
                        "OK",
                        mapOf("Cache-Control" to "private, max-age=86400"),
                        ByteArrayInputStream(bytes)
                    )
                }
            }
            "/api/open-file", "/api/orig" -> {
                val id = url.getQueryParameter("id")?.toIntOrNull() ?: -1
                val uris = scanResult?.uris
                if (uris != null && id in uris.indices) {
                    val photoUri = uris[id]
                    runOnUiThread {
                        try {
                            val intent = Intent(Intent.ACTION_VIEW).apply {
                                setDataAndType(photoUri, "image/*")
                                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                            }
                            startActivity(intent)
                        } catch (_: Exception) {
                        }
                    }
                }
                jsonResponse("""{"ok":true}""")
            }
            else -> {
                val assetName = if (path == "/" || path.isEmpty()) "index.html" else path.trimStart('/')
                try {
                    val stream = assets.open("static/$assetName")
                    val mime = when {
                        assetName.endsWith(".html") -> "text/html"
                        assetName.endsWith(".js") -> "application/javascript"
                        assetName.endsWith(".css") -> "text/css"
                        else -> "application/octet-stream"
                    }
                    WebResourceResponse(mime, "utf-8", stream)
                } catch (_: Exception) {
                    emptyResponse(404)
                }
            }
        }
    }

    private fun handlePickFolder(): WebResourceResponse {
        val options = PhotoScanner.listAvailableFolders(applicationContext)
        val nf = NumberFormat.getNumberInstance(Locale.KOREA)
        val labels = options.map { "${it.display}  (${nf.format(it.count)}장)" }.toTypedArray()
        val currentIdx = options.indexOfFirst { it.prefix == currentPrefix }.coerceAtLeast(0)

        val latch = CountDownLatch(1)
        val chosenRef = AtomicReference<String?>(null)

        runOnUiThread {
            if (isFinishing || isDestroyed) {
                latch.countDown()
                return@runOnUiThread
            }
            AlertDialog.Builder(this)
                .setTitle("사진 폴더 선택 (하위 폴더 포함)")
                .setSingleChoiceItems(labels, currentIdx) { dialog, which ->
                    chosenRef.set(options[which].prefix)
                    dialog.dismiss()
                    latch.countDown()
                }
                .setNegativeButton("취소") { dialog, _ ->
                    dialog.dismiss()
                    latch.countDown()
                }
                .setOnCancelListener {
                    latch.countDown()
                }
                .show()
        }

        latch.await(120, TimeUnit.SECONDS)
        val chosen = chosenRef.get()
        return if (chosen != null) {
            currentPrefix = chosen
            getSharedPreferences("photo_galaxy", MODE_PRIVATE)
                .edit()
                .putString("root_prefix", chosen)
                .apply()
            scanResult = null
            startScanAsync()
            val label = if (chosen.isEmpty()) "휴대폰 전체 사진" else chosen
            jsonResponse("""{"changed":true,"root":${org.json.JSONObject.quote(label)}}""")
        } else {
            val label = if (currentPrefix.isEmpty()) "휴대폰 전체 사진" else currentPrefix
            jsonResponse("""{"changed":false,"root":${org.json.JSONObject.quote(label)}}""")
        }
    }

    private fun jsonResponse(json: String, status: Int = 200): WebResourceResponse {
        return WebResourceResponse(
            "application/json",
            "utf-8",
            status,
            if (status == 200) "OK" else "Busy",
            mapOf("Cache-Control" to "no-cache"),
            ByteArrayInputStream(json.toByteArray(Charsets.UTF_8))
        )
    }

    private fun emptyResponse(status: Int): WebResourceResponse {
        return WebResourceResponse("text/plain", "utf-8", status, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
    }
}
