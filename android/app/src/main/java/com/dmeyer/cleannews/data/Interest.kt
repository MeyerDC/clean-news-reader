package com.dmeyer.cleannews.data

import android.database.sqlite.SQLiteDatabase
import android.util.Log
import java.util.Locale
import kotlin.math.pow

/**
 * What the curator knows about you.
 *
 * Every article carries features — its publisher, the categories the feed sent,
 * the words in its headline — and this counts, per feature, how often an
 * article carrying it was read and how often one was shown and ignored. That
 * pair is what lets the scorer ask "given this headline, how much does it look
 * like the things this reader opens?"
 *
 * Two things make it work on a phone with no server and no history table.
 *
 * The counts are *decayed*, not summed: each write ages what is already stored
 * by 0.5^(elapsed/halflife) before adding to it. So recency is arithmetic
 * rather than a query, and nothing ever has to be re-scanned. Two rates are
 * kept — a fast one for what you are into this month and a slow one for what
 * you have always read — so an interest that goes quiet fades from the first
 * while surviving in the second.
 *
 * And it is a rollup, so the evidence outlives its evidence: retention deletes
 * an unread article after seven days, and that article having been ignored is
 * precisely the negative example the scorer cannot do without.
 */
object Interest {

    private const val TAG = "Interest"

    private const val KIND_SOURCE = "source"
    private const val KIND_CATEGORY = "category"
    private const val KIND_TOKEN = "token"
    private const val KIND_AUTHOR = "author"

    private val FAST_HALFLIFE_MS = 10L * 24 * 60 * 60 * 1000   // ~10 days
    private val SLOW_HALFLIFE_MS = 120L * 24 * 60 * 60 * 1000  // ~4 months

    /** Headline words too common to say anything about taste. */
    private val STOPWORDS = setOf(
        "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for",
        "with", "at", "by", "from", "as", "is", "are", "was", "were", "be",
        "been", "it", "its", "this", "that", "these", "those", "will", "would",
        "can", "could", "has", "have", "had", "not", "no", "you", "your",
        "after", "over", "into", "out", "up", "down", "new", "says", "said",
        "how", "why", "what", "who", "when", "more", "than", "about"
    )

    private const val MIN_TOKEN_LENGTH = 4
    private const val MAX_TOKENS = 12

    /** The features one article contributes, as (kind, value) pairs. */
    fun featuresOf(
        sourceName: String?,
        categories: String?,
        title: String?,
        author: String?
    ): List<Pair<String, String>> {
        val features = mutableListOf<Pair<String, String>>()

        sourceName?.trim()?.takeIf { it.isNotEmpty() }
            ?.let { features.add(KIND_SOURCE to it.lowercase(Locale.ROOT)) }

        // Stored pipe-wrapped and already lowercased: "|sport|maverick news|".
        categories?.split('|')
            ?.map { it.trim() }
            ?.filter { it.isNotEmpty() }
            ?.forEach { features.add(KIND_CATEGORY to it) }

        author?.trim()?.takeIf { it.isNotEmpty() && it.length < 60 }
            ?.let { features.add(KIND_AUTHOR to it.lowercase(Locale.ROOT)) }

        tokenize(title).forEach { features.add(KIND_TOKEN to it) }
        return features
    }

    /**
     * Headline words, lowercased and stripped of punctuation. Deliberately
     * crude: a stemmer would be better and is not worth a dependency here,
     * because the categories carry most of the topical signal already and
     * these are the long tail.
     */
    fun tokenize(title: String?): List<String> {
        if (title.isNullOrBlank()) return emptyList()
        return title.lowercase(Locale.ROOT)
            .split(Regex("[^\\p{L}\\p{N}]+"))
            .asSequence()
            .filter { it.length >= MIN_TOKEN_LENGTH && it !in STOPWORDS }
            .distinct()
            .take(MAX_TOKENS)
            .toList()
    }

    /** An article was opened. */
    fun recordRead(db: SQLiteDatabase, articleId: Long) {
        record(db, articleId, read = true)
    }

    /**
     * Articles that were shown and never opened, recorded on their way out.
     * Called from retention: this is the only moment the negative evidence
     * exists, because the row is about to be deleted.
     */
    fun recordIgnored(db: SQLiteDatabase, articleIds: List<Long>) {
        articleIds.forEach { record(db, it, read = false) }
    }

    private fun record(db: SQLiteDatabase, articleId: Long, read: Boolean) {
        try {
            val row = db.rawQuery(
                "SELECT sourceName, categories, title, author FROM articles WHERE id = ?",
                arrayOf(articleId.toString())
            ).use { c ->
                if (!c.moveToFirst()) return
                listOf(
                    if (c.isNull(0)) null else c.getString(0),
                    if (c.isNull(1)) null else c.getString(1),
                    if (c.isNull(2)) null else c.getString(2),
                    if (c.isNull(3)) null else c.getString(3)
                )
            }
            val features = featuresOf(row[0], row[1], row[2], row[3])
            if (features.isEmpty()) return

            val now = System.currentTimeMillis()
            db.beginTransaction()
            try {
                features.forEach { (kind, value) -> bump(db, kind, value, read, now) }
                db.setTransactionSuccessful()
            } finally {
                db.endTransaction()
            }
        } catch (e: Exception) {
            // Learning is a nicety; losing a poll or a read over it is not.
            Log.w(TAG, "Could not record interest for $articleId", e)
        }
    }

    /**
     * A read is also a sighting. Counting it in both is what makes the ratio a
     * read *rate* rather than a popularity contest — otherwise a feature that
     * appears constantly would look interesting purely by volume.
     */
    private fun bump(db: SQLiteDatabase, kind: String, value: String, read: Boolean, now: Long) {
        val existing = db.rawQuery(
            "SELECT fastRead, fastSeen, slowRead, slowSeen, decayedAt FROM interest_stats " +
                "WHERE kind = ? AND value = ?",
            arrayOf(kind, value)
        ).use { c ->
            if (c.moveToFirst()) {
                listOf(c.getDouble(0), c.getDouble(1), c.getDouble(2), c.getDouble(3), c.getLong(4).toDouble())
            } else {
                null
            }
        }

        val elapsed = if (existing == null) 0L else (now - existing[4].toLong()).coerceAtLeast(0L)
        val fastFactor = decay(elapsed, FAST_HALFLIFE_MS)
        val slowFactor = decay(elapsed, SLOW_HALFLIFE_MS)

        val fastRead = (existing?.get(0) ?: 0.0) * fastFactor + if (read) 1.0 else 0.0
        val fastSeen = (existing?.get(1) ?: 0.0) * fastFactor + 1.0
        val slowRead = (existing?.get(2) ?: 0.0) * slowFactor + if (read) 1.0 else 0.0
        val slowSeen = (existing?.get(3) ?: 0.0) * slowFactor + 1.0

        db.execSQL(
            """
            INSERT INTO interest_stats (kind, value, fastRead, fastSeen, slowRead, slowSeen, decayedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(kind, value) DO UPDATE SET
                fastRead = excluded.fastRead, fastSeen = excluded.fastSeen,
                slowRead = excluded.slowRead, slowSeen = excluded.slowSeen,
                decayedAt = excluded.decayedAt
            """.trimIndent(),
            arrayOf<Any?>(kind, value, fastRead, fastSeen, slowRead, slowSeen, now)
        )
    }

    private fun decay(elapsedMs: Long, halflifeMs: Long): Double =
        if (elapsedMs <= 0) 1.0 else 0.5.pow(elapsedMs.toDouble() / halflifeMs)
}
