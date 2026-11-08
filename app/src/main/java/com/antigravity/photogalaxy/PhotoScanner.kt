package com.antigravity.photogalaxy

import android.content.ContentUris
import android.content.Context
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import org.json.JSONArray
import org.json.JSONObject
import java.util.Calendar
import java.util.Locale

data class ScanResult(
    val treeJson: ByteArray,
    val uris: List<Uri>,
    val folderCount: Int,
    val photoCount: Int,
)

data class FolderOption(
    val prefix: String,
    val display: String,
    val count: Int,
)

object PhotoScanner {

    private val numRegex = Regex("(\\d+)|(\\D+)")

    private fun naturalCompare(a: String, b: String): Int {
        val ma = numRegex.findAll(a).map { it.value }.toList()
        val mb = numRegex.findAll(b).map { it.value }.toList()
        val len = minOf(ma.size, mb.size)
        for (i in 0 until len) {
            val pa = ma[i]
            val pb = mb[i]
            val da = pa.toBigIntegerOrNull()
            val db = pb.toBigIntegerOrNull()
            val cmp = if (da != null && db != null) {
                da.compareTo(db)
            } else {
                pa.lowercase().compareTo(pb.lowercase())
            }
            if (cmp != 0) return cmp
        }
        return ma.size.compareTo(mb.size)
    }

    private data class RawPhoto(
        val uri: Uri,
        val name: String,
        val relDir: String,
        val timestampMs: Long,
    )

    private fun queryAllPhotos(context: Context): List<RawPhoto> {
        val list = ArrayList<RawPhoto>(4096)
        val collection = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
        } else {
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        }
        val projection = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            arrayOf(
                MediaStore.Images.Media._ID,
                MediaStore.Images.Media.DISPLAY_NAME,
                MediaStore.Images.Media.RELATIVE_PATH,
                MediaStore.Images.Media.DATE_TAKEN,
                MediaStore.Images.Media.DATE_MODIFIED,
            )
        } else {
            @Suppress("DEPRECATION")
            arrayOf(
                MediaStore.Images.Media._ID,
                MediaStore.Images.Media.DISPLAY_NAME,
                MediaStore.Images.Media.DATA,
                MediaStore.Images.Media.DATE_TAKEN,
                MediaStore.Images.Media.DATE_MODIFIED,
            )
        }

        try {
            context.contentResolver.query(collection, projection, null, null, null)?.use { c ->
                val idCol = c.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
                val nameCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.DISPLAY_NAME)
                val pathCol = c.getColumnIndex(
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
                        MediaStore.Images.Media.RELATIVE_PATH
                    else
                        @Suppress("DEPRECATION") MediaStore.Images.Media.DATA
                )
                val takenCol = c.getColumnIndex(MediaStore.Images.Media.DATE_TAKEN)
                val modCol = c.getColumnIndex(MediaStore.Images.Media.DATE_MODIFIED)

                while (c.moveToNext()) {
                    val id = c.getLong(idCol)
                    val name = c.getString(nameCol) ?: "photo_$id.jpg"
                    val rawPath = if (pathCol >= 0) (c.getString(pathCol) ?: "") else ""
                    val relDir = normalizeRelDir(rawPath)
                    val taken = if (takenCol >= 0 && !c.isNull(takenCol)) c.getLong(takenCol) else 0L
                    val mod = if (modCol >= 0 && !c.isNull(modCol)) c.getLong(modCol) * 1000L else 0L
                    val ts = when {
                        taken > 946684800000L -> taken // after year 2000
                        mod > 946684800000L -> mod
                        taken > 0L -> taken
                        mod > 0L -> mod
                        else -> System.currentTimeMillis()
                    }
                    val uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)
                    list.add(RawPhoto(uri, name, relDir, ts))
                }
            }
        } catch (_: SecurityException) {
            // Permission not granted yet
        } catch (_: Exception) {
        }
        return list
    }

    private fun normalizeRelDir(raw: String): String {
        var s = raw.replace('\\', '/').trim('/')
        val idx = s.indexOf("/0/")
        if (idx >= 0) {
            s = s.substring(idx + 3)
            val slash = s.lastIndexOf('/')
            s = if (slash >= 0) s.substring(0, slash) else ""
        }
        return s.trim('/')
    }

    fun listAvailableFolders(context: Context): List<FolderOption> {
        val all = queryAllPhotos(context)
        val counts = HashMap<String, Int>()
        for (p in all) {
            if (p.relDir.isEmpty()) continue
            val parts = p.relDir.split('/').filter { it.isNotEmpty() }
            var cur = ""
            for (part in parts) {
                cur = if (cur.isEmpty()) part else "$cur/$part"
                counts[cur] = (counts[cur] ?: 0) + 1
            }
        }
        val options = ArrayList<FolderOption>()
        options.add(FolderOption("", "📱 전체 사진 (모든 폴더)", all.size))
        counts.entries
            .sortedWith { a, b ->
                val cmp = b.value.compareTo(a.value)
                if (cmp != 0) cmp else naturalCompare(a.key, b.key)
            }
            .take(150)
            .forEach { (prefix, cnt) ->
                options.add(FolderOption(prefix, "📁 $prefix", cnt))
            }
        return options
    }

    fun scanAndBuildTree(context: Context, rootPrefix: String, mode: String = "month"): ScanResult {
        val cleanPrefix = rootPrefix.trim('/')
        val all = queryAllPhotos(context)
        val filtered = if (cleanPrefix.isEmpty()) {
            all
        } else {
            all.filter { it.relDir == cleanPrefix || it.relDir.startsWith("$cleanPrefix/") }
        }

        class Node(val name: String) {
            val children = HashMap<String, Node>()
            val photos = ArrayList<RawPhoto>()
            var id = 0
            var parentId = -1
            var start = 0
            var count = 0
            var total = 0
        }

        val rootName = if (cleanPrefix.isEmpty()) "내 휴대폰 사진" else cleanPrefix.substringAfterLast('/')
        val rootNode = Node(rootName)
        val cal = Calendar.getInstance()

        for (p in filtered) {
            val virtualPath = when (mode) {
                "month" -> {
                    cal.timeInMillis = p.timestampMs
                    val y = cal.get(Calendar.YEAR)
                    val m = cal.get(Calendar.MONTH) + 1
                    String.format(Locale.US, "%04d년/%02d월", y, m)
                }
                "day" -> {
                    cal.timeInMillis = p.timestampMs
                    val y = cal.get(Calendar.YEAR)
                    val m = cal.get(Calendar.MONTH) + 1
                    val d = cal.get(Calendar.DAY_OF_MONTH)
                    String.format(Locale.US, "%04d년/%02d월/%02d일", y, m, d)
                }
                else -> {
                    if (cleanPrefix.isEmpty()) {
                        p.relDir
                    } else if (p.relDir == cleanPrefix) {
                        ""
                    } else {
                        p.relDir.removePrefix("$cleanPrefix/")
                    }
                }
            }

            var cur = rootNode
            if (virtualPath.isNotEmpty()) {
                for (part in virtualPath.split('/').filter { it.isNotEmpty() }) {
                    cur = cur.children.getOrPut(part) { Node(part) }
                }
            }
            cur.photos.add(p)
        }

        val orderedFolders = ArrayList<Node>()
        val orderedPhotos = ArrayList<RawPhoto>(filtered.size)
        val isDateMode = mode == "month" || mode == "day"

        fun dfs(node: Node, parentId: Int) {
            node.id = orderedFolders.size
            node.parentId = parentId
            orderedFolders.add(node)

            if (isDateMode) {
                node.photos.sortWith { a, b ->
                    val cmp = a.timestampMs.compareTo(b.timestampMs)
                    if (cmp != 0) cmp else naturalCompare(a.name, b.name)
                }
            } else {
                node.photos.sortWith { a, b -> naturalCompare(a.name, b.name) }
            }
            node.start = orderedPhotos.size
            node.count = node.photos.size
            orderedPhotos.addAll(node.photos)

            val sortedKids = node.children.values.sortedWith { a, b -> naturalCompare(a.name, b.name) }
            for (child in sortedKids) {
                dfs(child, node.id)
            }
        }

        dfs(rootNode, -1)

        for (i in orderedFolders.indices.reversed()) {
            val f = orderedFolders[i]
            f.total += f.count
            if (f.parentId >= 0) {
                orderedFolders[f.parentId].total += f.total
            }
        }

        val remap = HashMap<Int, Int>()
        val foldersJson = JSONArray()
        for (i in orderedFolders.indices) {
            val f = orderedFolders[i]
            if (f.total == 0 && i != 0) continue
            val newId = foldersJson.length()
            remap[i] = newId
            val row = JSONArray()
            row.put(if (f.parentId >= 0) (remap[f.parentId] ?: 0) else -1)
            row.put(f.name)
            row.put(f.start)
            row.put(f.count)
            row.put(f.total)
            foldersJson.put(row)
        }

        val photosJson = JSONArray()
        val uris = ArrayList<Uri>(orderedPhotos.size)
        for (p in orderedPhotos) {
            photosJson.put(p.name)
            uris.add(p.uri)
        }

        val rootLabel = if (cleanPrefix.isEmpty()) "휴대폰 전체 사진" else cleanPrefix
        val treeObj = JSONObject().apply {
            put("root", rootLabel)
            put("rootName", rootName)
            put("mode", mode)
            put("version", "${System.currentTimeMillis() / 1000L}_$mode")
            put("folders", foldersJson)
            put("photos", photosJson)
        }

        val rawBytes = treeObj.toString().toByteArray(Charsets.UTF_8)

        return ScanResult(
            treeJson = rawBytes,
            uris = uris,
            folderCount = foldersJson.length(),
            photoCount = uris.size,
        )
    }
}
