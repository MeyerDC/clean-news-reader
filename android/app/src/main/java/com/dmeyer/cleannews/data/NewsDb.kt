package com.dmeyer.cleannews.data

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.util.Log
import java.io.File

/**
 * Direct SQLite access for the native side.
 *
 * We deliberately do not use SQLiteOpenHelper: the same file is opened
 * concurrently by the Capacitor SQLite plugin in the webview process, and
 * OpenHelper's version/upgrade bookkeeping would fight with it. Instead every
 * schema statement is idempotent and both sides just run them on open.
 */
object NewsDb {

    @Volatile
    private var instance: SQLiteDatabase? = null

    fun get(context: Context): SQLiteDatabase {
        instance?.let { if (it.isOpen) return it }
        synchronized(this) {
            instance?.let { if (it.isOpen) return it }
            val db = open(context.applicationContext)
            instance = db
            return db
        }
    }

    private fun open(context: Context): SQLiteDatabase {
        val path: File = context.getDatabasePath(Schema.DB_FILE)
        path.parentFile?.mkdirs()
        val db = SQLiteDatabase.openOrCreateDatabase(path, null)

        // Deliberately NOT write-ahead logging. This file is opened by two
        // independent SQLite stacks — Android's SQLiteDatabase here, and the
        // Capacitor plugin's own connection in the webview — and under WAL the
        // most recent frames written from this side went missing when the other
        // side touched the file. A rollback journal commits straight into the
        // database file, which both stacks then agree on.
        //
        // Nothing is lost by this: the widget's RemoteViewsService runs in this
        // same process, so there is no cross-process reader that WAL would help.
        db.disableWriteAheadLogging()
        db.rawQuery("PRAGMA busy_timeout = 5000", null).use { it.moveToFirst() }
        Schema.TABLE_STATEMENTS.forEach { db.execSQL(it) }
        addMissingColumns(db)
        Schema.INDEX_STATEMENTS.forEach { db.execSQL(it) }
        seedFeedsIfEmpty(db)
        return db
    }

    /** Brings an existing database up to the current column set. */
    private fun addMissingColumns(db: SQLiteDatabase) {
        addColumns(db, "articles", Schema.ADDED_COLUMNS)
        addColumns(db, "feeds", Schema.ADDED_FEED_COLUMNS)
    }

    private fun addColumns(
        db: SQLiteDatabase,
        table: String,
        columns: List<Pair<String, String>>
    ) {
        val existing = db.rawQuery("PRAGMA table_info($table)", null).use { c ->
            val names = mutableSetOf<String>()
            val nameIndex = c.getColumnIndex("name")
            while (c.moveToNext()) names.add(c.getString(nameIndex))
            names
        }
        columns.forEach { (column, statement) ->
            if (column !in existing) {
                runCatching { db.execSQL(statement) }
                    .onFailure { Log.w("NewsDb", "Could not add $table.$column", it) }
            }
        }
    }

    private fun seedFeedsIfEmpty(db: SQLiteDatabase) {
        if (getSetting(db, SettingKeys.FEEDS_SEEDED) == "1") return
        val count = db.rawQuery("SELECT COUNT(*) FROM feeds", null).use { c ->
            if (c.moveToFirst()) c.getInt(0) else 0
        }
        if (count == 0) {
            db.beginTransaction()
            try {
                Schema.DEFAULT_FEEDS.forEachIndexed { order, seed ->
                    val values = ContentValues().apply {
                        put("url", seed.url)
                        put("sourceName", seed.sourceName)
                        put("title", seed.sourceName)
                        put("enabled", if (seed.enabled) 1 else 0)
                        put("sortOrder", order)
                        put("consecutiveFailures", 0)
                        put("lastError", seed.note)
                    }
                    db.insertWithOnConflict("feeds", null, values, SQLiteDatabase.CONFLICT_IGNORE)
                }
                db.setTransactionSuccessful()
            } finally {
                db.endTransaction()
            }
        }
        putSetting(db, SettingKeys.FEEDS_SEEDED, "1")
    }

    // ---- settings helpers -------------------------------------------------

    fun getSetting(db: SQLiteDatabase, key: String): String? =
        db.rawQuery("SELECT value FROM settings WHERE key = ?", arrayOf(key)).use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }

    fun putSetting(db: SQLiteDatabase, key: String, value: String) {
        db.execSQL(
            "INSERT INTO settings (key, value) VALUES (?, ?) " +
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            arrayOf(key, value)
        )
    }

    fun getIntSetting(db: SQLiteDatabase, key: String, fallback: Int): Int =
        getSetting(db, key)?.toIntOrNull() ?: fallback

    // ---- small cursor conveniences ---------------------------------------

    fun Cursor.stringOrNull(column: String): String? {
        val idx = getColumnIndex(column)
        return if (idx >= 0 && !isNull(idx)) getString(idx) else null
    }

    fun Cursor.longOrNull(column: String): Long? {
        val idx = getColumnIndex(column)
        return if (idx >= 0 && !isNull(idx)) getLong(idx) else null
    }

    fun Cursor.intOr(column: String, fallback: Int): Int {
        val idx = getColumnIndex(column)
        return if (idx >= 0 && !isNull(idx)) getInt(idx) else fallback
    }
}
