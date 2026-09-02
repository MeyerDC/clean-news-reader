package com.dmeyer.cleannews.data

import android.database.sqlite.SQLiteDatabase
import android.util.Log

/**
 * Builds the curated list: the articles picked for you, rather than the ones
 * that happened to arrive last.
 *
 * It runs here, in the native layer, because the widget shows the same picks
 * and has to be fed while the app is closed. The app reads the same table, so
 * there is one writer and two readers and the two surfaces cannot drift into
 * showing different "top ten" lists.
 *
 * This pass ranks by recency with a per-source cap. That is deliberately not
 * the finished article: the interest scoring needs weeks of readAt history
 * before it can be tuned against anything real, and a list that is visibly
 * wrong is easier to improve than one that does not exist.
 */
object Curator {

    private const val TAG = "Curator"

    /** How many picks the surfaces show. */
    const val VISIBLE = 10

    /**
     * How many are actually stored. The extra six are reserves: reading a pick
     * removes it from the widget, and a reserve promotes into its place with
     * its thumbnail already on disk. Without them the widget drains through the
     * afternoon and there is no way to top it up — the widget's process has no
     * network and cannot fetch a replacement image at render time.
     */
    const val STORED = 16

    private const val DEFAULT_INTERVAL_MINUTES = 150
    private const val MIN_INTERVAL_MINUTES = 60
    private const val MAX_INTERVAL_MINUTES = 480

    /** No source may own more than this many of the picks. */
    private const val PER_SOURCE_CAP = 2

    /** Chosen on merit. */
    private const val POOL_RECENT = "recent"

    /**
     * Chosen at random to make the count up. Tagged so the app can tell the
     * difference, and so that opening one is never later mistaken for evidence
     * of interest when the scoring in step 4 reads this history back.
     */
    private const val POOL_FILLER = "filler"

    /**
     * Called at the end of every poll. Curation itself is far slower than the
     * poll cycle — the list is meant to hold still for a couple of hours, not
     * churn every thirty minutes — so most calls do nothing.
     */
    fun runIfDue(db: SQLiteDatabase): Boolean {
        val now = System.currentTimeMillis()
        val last = NewsDb.getSetting(db, SettingKeys.CURATED_AT)?.toLongOrNull() ?: 0L
        val intervalMs = intervalMinutes(db) * 60_000L

        val stale = now - last >= intervalMs
        // Reading the picks empties the widget. Once the reserves are gone
        // there is nothing left to promote, so rebuild early rather than show
        // a short list for the rest of the interval.
        val drained = liveCount(db) < VISIBLE

        if (!stale && !drained) return false

        return try {
            val picked = curate(db, now)
            NewsDb.putSetting(db, SettingKeys.CURATED_AT, now.toString())
            Log.i(
                TAG,
                "Curated %d picks (stale=%s drained=%s confidence=%.2f)"
                    .format(picked, stale, drained, Scorer.confidenceOf(db))
            )
            true
        } catch (e: Exception) {
            // A failed curation must not fail the poll: the previous picks are
            // still in the table and still readable.
            Log.w(TAG, "Curation failed; keeping the previous picks", e)
            false
        }
    }

    fun intervalMinutes(db: SQLiteDatabase): Int =
        NewsDb.getIntSetting(db, SettingKeys.CURATION_INTERVAL_MINUTES, DEFAULT_INTERVAL_MINUTES)
            .coerceIn(MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES)

    /** Picks that are still worth showing: read ones drop out immediately. */
    fun liveCount(db: SQLiteDatabase): Int =
        db.rawQuery(
            """
            SELECT COUNT(*) FROM curated_picks p
            JOIN articles a ON a.id = p.articleId
            WHERE a.isRead = 0 AND a.isDismissed = 0 AND a.isArchived = 0
            """.trimIndent(),
            null
        ).use { c -> if (c.moveToFirst()) c.getInt(0) else 0 }

    /** Source names by id, so the per-source cap needs no join per candidate. */
    private fun sourceNames(db: SQLiteDatabase): Map<Long, String> {
        val map = HashMap<Long, String>()
        db.rawQuery("SELECT id, COALESCE(sourceName, '') FROM articles", null).use { c ->
            while (c.moveToNext()) map[c.getLong(0)] = c.getString(1)
        }
        return map
    }

    private fun curate(db: SQLiteDatabase, now: Long): Int {
        val chosen = LinkedHashMap<Long, String>()

        // Every eligible article is scored, not just the newest few hundred: a
        // piece that matches this reader closely should be able to win a slot
        // on its third day. The filters are hard gates inside the scorer —
        // unread, not paywalled, not video-only — because promoting something
        // that cannot be read cleanly wastes one of ten slots.
        val ranked = Scorer.scoreAll(db, now)
        val sources = sourceNames(db)

        val perSource = mutableMapOf<String, Int>()
        for (verdict in ranked) {
            if (chosen.size >= STORED) break
            val source = sources[verdict.articleId].orEmpty()
            val used = perSource[source] ?: 0
            // One prolific feed would otherwise own the whole list: on a busy
            // afternoon Daily Maverick alone can fill ten slots.
            if (source.isNotEmpty() && used >= PER_SOURCE_CAP) continue
            perSource[source] = used + 1
            chosen[verdict.articleId] = POOL_RECENT
        }

        // The list is always ten if ten exist. Anything short of that is topped
        // up at random — a fresh install, a quiet morning, or an afternoon of
        // heavy reading all end up here.
        if (chosen.size < STORED) {
            val exclude = if (chosen.isEmpty()) "0" else chosen.keys.joinToString(",")
            db.rawQuery(
                """
                SELECT id FROM articles
                WHERE isRead = 0 AND isDismissed = 0 AND isArchived = 0
                  AND id NOT IN ($exclude)
                ORDER BY (imageUrl IS NOT NULL) DESC, RANDOM()
                LIMIT ${STORED - chosen.size}
                """.trimIndent(),
                null
            ).use { c ->
                // Ordered so anything carrying a picture is taken first: these
                // land in the band that is supposed to show thumbnails, and a
                // filler is the pick least likely to have one.
                while (c.moveToNext()) chosen[c.getLong(0)] = POOL_FILLER
            }
        }

        db.beginTransaction()
        try {
            // Replaced wholesale rather than merged. The randomness is rolled
            // once, here, and then frozen: re-rolling it per read would reshuffle
            // the widget on every redraw the launcher asks for.
            db.execSQL("DELETE FROM curated_picks")
            chosen.entries.forEachIndexed { rank, (articleId, pool) ->
                db.execSQL(
                    "INSERT INTO curated_picks (articleId, rank, pool, curatedAt) VALUES (?, ?, ?, ?)",
                    arrayOf<Any?>(articleId, rank, pool, now)
                )
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        return chosen.size
    }
}
