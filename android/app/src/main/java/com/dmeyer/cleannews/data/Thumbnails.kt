package com.dmeyer.cleannews.data

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Log
import com.dmeyer.cleannews.feed.HttpFetch
import java.io.File

/**
 * Thumbnails for the curated picks, shared by the widget and the app.
 *
 * Both surfaces need the file rather than the URL, for different reasons. The
 * widget's list is drawn in the launcher's process, which has no network. And
 * the webview is forbidden from loading remote images at all — see the
 * Content-Security-Policy in index.html — because this app never hot-links to
 * a publisher; every picture it shows is fetched natively first and served
 * from disk.
 *
 * So one download at curation time feeds both, and both work offline.
 */
object Thumbnails {

    private const val TAG = "Thumbnails"

    /** Relative to filesDir, alongside Retention.IMAGE_DIR. */
    const val DIR = "thumbnails"

    /**
     * Deliberately small. Every row's bitmap crosses a binder transaction to
     * the launcher, and the whole RemoteViews budget is a fraction of a screen
     * of pixels — a full-size press photo in ten rows overruns it and the
     * widget silently fails to draw.
     */
    private const val TARGET_WIDTH_PX = 150
    private const val MAX_SOURCE_BYTES = 3 * 1024 * 1024
    private const val JPEG_QUALITY = 82

    /**
     * Fetches what the current picks are missing and drops what nothing points
     * at any more. Safe to call on every curation: a pick that already has its
     * file costs one query and no network.
     */
    fun sync(context: Context, db: SQLiteDatabase) {
        val dir = File(context.filesDir, DIR).apply { mkdirs() }

        val wanted = mutableSetOf<String>()
        val pending = mutableListOf<Triple<Long, String, String?>>()

        db.rawQuery(
            """
            SELECT p.articleId, a.imageUrl, p.thumbPath
            FROM curated_picks p
            JOIN articles a ON a.id = p.articleId
            WHERE a.imageUrl IS NOT NULL AND a.imageUrl <> ''
            """.trimIndent(),
            null
        ).use { c ->
            while (c.moveToNext()) {
                val id = c.getLong(0)
                val url = c.getString(1) ?: continue
                val existing = if (c.isNull(2)) null else c.getString(2)
                pending.add(Triple(id, url, existing))
            }
        }

        for ((articleId, url, existing) in pending) {
            val name = "$articleId.jpg"
            val file = File(dir, name)
            val relative = "$DIR/$name"

            if (existing == relative && file.exists() && file.length() > 0) {
                wanted.add(name)
                continue
            }

            val bytes = HttpFetch.getBytes(url, MAX_SOURCE_BYTES) ?: continue
            val bitmap = decodeScaled(bytes) ?: continue
            try {
                file.outputStream().use { out ->
                    bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
                }
                db.execSQL(
                    "UPDATE curated_picks SET thumbPath = ? WHERE articleId = ?",
                    arrayOf<Any?>(relative, articleId)
                )
                wanted.add(name)
            } catch (e: Exception) {
                Log.w(TAG, "Could not write thumbnail for $articleId", e)
            } finally {
                bitmap.recycle()
            }
        }

        // Files first would orphan a row pointing at nothing; the rows for the
        // previous picks are already gone, so anything not claimed above is
        // unreferenced by definition.
        dir.listFiles()?.forEach { file ->
            if (file.name !in wanted) runCatching { file.delete() }
        }
    }

    /** Everything in the directory, for "clear cache". */
    fun clear(context: Context) {
        File(context.filesDir, DIR).listFiles()?.forEach { runCatching { it.delete() } }
    }

    /**
     * Decoded at a power-of-two sample first so a 4000px press photo never
     * lands in memory whole, then scaled to the exact width.
     */
    private fun decodeScaled(bytes: ByteArray): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

        var sample = 1
        while (bounds.outWidth / (sample * 2) >= TARGET_WIDTH_PX) sample *= 2

        val options = BitmapFactory.Options().apply {
            inSampleSize = sample
            // RGB_565 halves the bytes crossing the binder call. These are
            // 220px thumbnails behind rounded corners; the missing alpha and
            // colour depth are not visible at that size.
            inPreferredConfig = Bitmap.Config.RGB_565
        }
        val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) ?: return null
        if (decoded.width <= TARGET_WIDTH_PX) return decoded

        val height = (decoded.height * (TARGET_WIDTH_PX.toFloat() / decoded.width)).toInt().coerceAtLeast(1)
        return try {
            Bitmap.createScaledBitmap(decoded, TARGET_WIDTH_PX, height, true).also {
                if (it !== decoded) decoded.recycle()
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not scale thumbnail", e)
            decoded
        }
    }
}
