package com.antigravity.photogalaxy

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import android.util.Size
import java.io.ByteArrayOutputStream

object ImageHelper {

    private fun readOrientation(context: Context, uri: Uri): Int {
        return try {
            context.contentResolver.openInputStream(uri)?.use { ins ->
                ExifInterface(ins).getAttributeInt(
                    ExifInterface.TAG_ORIENTATION,
                    ExifInterface.ORIENTATION_NORMAL
                )
            } ?: ExifInterface.ORIENTATION_NORMAL
        } catch (_: Exception) {
            ExifInterface.ORIENTATION_NORMAL
        }
    }

    private fun applyOrientation(bmp: Bitmap, orientation: Int): Bitmap {
        val m = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.setScale(-1f, 1f)
            ExifInterface.ORIENTATION_ROTATE_180 -> m.setRotate(180f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> {
                m.setRotate(180f)
                m.postScale(-1f, 1f)
            }
            ExifInterface.ORIENTATION_TRANSPOSE -> {
                m.setRotate(90f)
                m.postScale(-1f, 1f)
            }
            ExifInterface.ORIENTATION_ROTATE_90 -> m.setRotate(90f)
            ExifInterface.ORIENTATION_TRANSVERSE -> {
                m.setRotate(-90f)
                m.postScale(-1f, 1f)
            }
            ExifInterface.ORIENTATION_ROTATE_270 -> m.setRotate(-90f)
            else -> return bmp
        }
        return try {
            val rotated = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
            if (rotated != bmp) bmp.recycle()
            rotated
        } catch (_: Exception) {
            bmp
        }
    }

    private fun encodeJpeg(bmp: Bitmap, quality: Int = 85): ByteArray {
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, quality, out)
        return out.toByteArray()
    }

    fun thumbnail(context: Context, uri: Uri): ByteArray? {
        // 1. Fast path: embedded EXIF thumbnail
        try {
            context.contentResolver.openInputStream(uri)?.use { ins ->
                val exif = ExifInterface(ins)
                if (exif.hasThumbnail()) {
                    val data = exif.thumbnailBytes
                    if (data != null && data.isNotEmpty()) {
                        val orient = exif.getAttributeInt(
                            ExifInterface.TAG_ORIENTATION,
                            ExifInterface.ORIENTATION_NORMAL
                        )
                        if (orient == ExifInterface.ORIENTATION_NORMAL || orient == ExifInterface.ORIENTATION_UNDEFINED) {
                            return data
                        }
                        val bmp = BitmapFactory.decodeByteArray(data, 0, data.size)
                        if (bmp != null) {
                            val fixed = applyOrientation(bmp, orient)
                            val bytes = encodeJpeg(fixed, 85)
                            fixed.recycle()
                            return bytes
                        }
                    }
                }
            }
        } catch (_: Exception) {
        }

        // 2. Android 10+ OS thumbnail loader
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            try {
                val bmp = context.contentResolver.loadThumbnail(uri, Size(200, 200), null)
                val bytes = encodeJpeg(bmp, 85)
                bmp.recycle()
                return bytes
            } catch (_: Exception) {
            }
        }

        // 3. Fallback: reduced sample decode
        return resized(context, uri, 256)
    }

    fun resized(context: Context, uri: Uri, targetSize: Int): ByteArray? {
        return try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            context.contentResolver.openInputStream(uri)?.use { ins ->
                BitmapFactory.decodeStream(ins, null, bounds)
            }
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

            var sample = 1
            val maxDim = maxOf(bounds.outWidth, bounds.outHeight)
            while (maxDim / (sample * 2) >= targetSize) {
                sample *= 2
            }

            val opts = BitmapFactory.Options().apply {
                inSampleSize = sample
                inPreferredConfig = Bitmap.Config.RGB_565
            }
            var bmp = context.contentResolver.openInputStream(uri)?.use { ins ->
                BitmapFactory.decodeStream(ins, null, opts)
            } ?: return null

            val curMax = maxOf(bmp.width, bmp.height)
            if (curMax > targetSize) {
                val ratio = targetSize.toFloat() / curMax.toFloat()
                val nw = maxOf(1, (bmp.width * ratio).toInt())
                val nh = maxOf(1, (bmp.height * ratio).toInt())
                val scaled = Bitmap.createScaledBitmap(bmp, nw, nh, true)
                if (scaled != bmp) bmp.recycle()
                bmp = scaled
            }

            val orient = readOrientation(context, uri)
            bmp = applyOrientation(bmp, orient)
            val bytes = encodeJpeg(bmp, 85)
            bmp.recycle()
            bytes
        } catch (_: Exception) {
            null
        }
    }
}
