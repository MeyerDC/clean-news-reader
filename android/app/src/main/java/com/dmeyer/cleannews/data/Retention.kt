package com.dmeyer.cleannews.data

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.util.Log
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * FR-10: retention. Unread feed articles live 7 days, read feed articles 2
 * days, and saved (shared-in) articles stay until the user deletes them.
 *
 * Cached image files are removed alongside their article so the filesystem does
 * not outlive the database rows.
 */
object Retention {

    private const val TAG = "Retention"
    const val IMAGE_DIR = "article-images"

    private val UNREAD_TTL = TimeUnit.DAYS.toMillis(7)
    private val READ_TTL = TimeUnit.DAYS.toMillis(2)

    fun run(context: Context, db: SQLiteDatabase): Int {
        val now = System.currentTimeMillis()
        val unreadCutoff = now - UNREAD_TTL
        val readCutoff = now - READ_TTL

        // CAST is load-bearing: rawQuery binds every argument as text, and
        // COALESCE(...) carries no column affinity, so without it SQLite would
        // compare these timestamps as strings and act on the wrong rows.

        // An article you read and have now finished with stops being a cached
        // page and becomes a search record: its images go, it leaves the list,
        // but its text stays. This is the amendment to FR-10 that makes search
        // reach further back than the cache window.
        val toArchive = db.rawQuery(
            """
            SELECT id FROM articles
            WHERE isSaved = 0 AND isArchived = 0 AND isRead = 1
              AND COALESCE(publishedAt, fetchedAt, 0) < CAST(? AS INTEGER)
            """.trimIndent(),
            arrayOf(readCutoff.toString())
        ).use { c ->
            val ids = mutableListOf<Long>()
            while (c.moveToNext()) ids.add(c.getLong(0))
            ids
        }

        // An article you never opened is not history, it is noise, and it goes
        // entirely — otherwise the archive fills up with everything the feeds
        // ever published rather than everything you read.
        val toDelete = db.rawQuery(
            """
            SELECT id FROM articles
            WHERE isSaved = 0 AND isArchived = 0 AND isRead = 0
              AND COALESCE(publishedAt, fetchedAt, 0) < CAST(? AS INTEGER)
            """.trimIndent(),
            arrayOf(unreadCutoff.toString())
        ).use { c ->
            val ids = mutableListOf<Long>()
            while (c.moveToNext()) ids.add(c.getLong(0))
            ids
        }

        if (toArchive.isNotEmpty()) {
            archiveArticles(context, db, toArchive)
            Log.i(TAG, "Retention archived ${toArchive.size} read articles")
        }
        if (toDelete.isNotEmpty()) {
            deleteArticles(context, db, toDelete)
            Log.i(TAG, "Retention removed ${toDelete.size} unread articles")
        }
        return toArchive.size + toDelete.size
    }

    /**
     * Drops an article's cached images and takes it out of the list, keeping
     * the text so it stays searchable.
     */
    fun archiveArticles(context: Context, db: SQLiteDatabase, ids: List<Long>) {
        if (ids.isEmpty()) return
        val now = System.currentTimeMillis()
        ids.chunked(400).forEach { chunk ->
            val placeholders = chunk.joinToString(",") { "?" }
            val args = chunk.map { it.toString() }.toTypedArray()

            deleteImageFiles(context, db, placeholders, args)

            db.beginTransaction()
            try {
                db.execSQL("DELETE FROM cached_images WHERE articleId IN ($placeholders)", args)
                db.execSQL(
                    "UPDATE articles SET isArchived = 1, archivedAt = ?, leadImagePath = NULL, " +
                        "scrollPosition = 0 WHERE id IN ($placeholders)",
                    (listOf<Any?>(now) + args).toTypedArray()
                )
                db.setTransactionSuccessful()
            } finally {
                db.endTransaction()
            }
        }
    }

    /**
     * FR-10: "Clear cache" — drops everything cacheable but never touches saved
     * articles.
     */
    fun clearCache(context: Context, db: SQLiteDatabase): Int {
        // Archived rows hold no files, only text, so clearing the *cache*
        // leaves them alone — that is the point of keeping them.
        val ids = db.rawQuery(
            "SELECT id FROM articles WHERE isSaved = 0 AND isArchived = 0", null
        ).use { c ->
            val list = mutableListOf<Long>()
            while (c.moveToNext()) list.add(c.getLong(0))
            list
        }
        deleteArticles(context, db, ids)
        return ids.size
    }

    fun deleteArticles(context: Context, db: SQLiteDatabase, ids: List<Long>) {
        if (ids.isEmpty()) return
        ids.chunked(400).forEach { chunk ->
            val placeholders = chunk.joinToString(",") { "?" }
            val args = chunk.map { it.toString() }.toTypedArray()

            deleteImageFiles(context, db, placeholders, args)

            db.beginTransaction()
            try {
                db.execSQL("DELETE FROM cached_images WHERE articleId IN ($placeholders)", args)
                db.execSQL("DELETE FROM articles WHERE id IN ($placeholders)", args)
                db.setTransactionSuccessful()
            } finally {
                db.endTransaction()
            }
        }
    }

    /**
     * Removes the files first: if the process dies mid-way we would rather
     * leak a row than orphan a file with no row pointing at it.
     */
    private fun deleteImageFiles(
        context: Context,
        db: SQLiteDatabase,
        placeholders: String,
        args: Array<String>
    ) {
        db.rawQuery(
            "SELECT localPath FROM cached_images WHERE articleId IN ($placeholders)",
            args
        ).use { c ->
            while (c.moveToNext()) {
                val relative = c.getString(0) ?: continue
                runCatching { File(context.filesDir, relative).delete() }
                    .onFailure { Log.w(TAG, "Could not delete $relative", it) }
            }
        }
    }

    /** Total bytes held by cached images, for the settings screen (FR-11). */
    fun cacheSizeBytes(context: Context): Long {
        val dir = File(context.filesDir, IMAGE_DIR)
        if (!dir.isDirectory) return 0
        return dir.walkTopDown().filter { it.isFile }.sumOf { it.length() }
    }
}
