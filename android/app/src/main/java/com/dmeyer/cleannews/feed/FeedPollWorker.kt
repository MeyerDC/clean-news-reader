package com.dmeyer.cleannews.feed

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.dmeyer.cleannews.bridge.PollEvents
import com.dmeyer.cleannews.data.ExtractionState
import com.dmeyer.cleannews.data.NewsDb
import com.dmeyer.cleannews.data.NewsDb.intOr
import com.dmeyer.cleannews.data.NewsDb.longOrNull
import com.dmeyer.cleannews.data.NewsDb.stringOrNull
import com.dmeyer.cleannews.data.Retention
import com.dmeyer.cleannews.data.SettingKeys
import com.dmeyer.cleannews.widget.HeadlinesWidgetProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

private data class FeedRow(
    val id: Long,
    val url: String,
    val sourceName: String,
    val etag: String?,
    val lastModified: String?,
    val consecutiveFailures: Int
)

/**
 * Spec 4.1: feed polling lives here, in the native layer, not in Angular. It
 * runs whether or not the app is open, writes into the shared database, and
 * then nudges the widget.
 */
class FeedPollWorker(context: Context, params: WorkerParameters) :
    CoroutineWorker(context, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        // The periodic schedule and a manual "refresh now" are separate pieces
        // of unique work, so WorkManager will happily run them at the same
        // moment. Two concurrent write transactions against one SQLite file is
        // never what we want, so the second run waits for the first.
        pollLock.withLock { runPoll() }
    }

    private suspend fun runPoll(): Result {
        val db = NewsDb.get(applicationContext)
        var stored = 0
        try {
            stored = pollAllFeeds(db)
            NewsDb.putSetting(db, SettingKeys.LAST_REFRESH_AT, System.currentTimeMillis().toString())
            runRetentionIfDue(db)
        } catch (e: Exception) {
            Log.e(TAG, "Poll run failed", e)
            // A whole-run failure is worth retrying; per-feed failures are
            // recorded against the feed and do not fail the run (FR-1).
            return Result.retry()
        } finally {
            // FR-3: the widget updates whenever the polling job completes, even
            // if some feeds errored — partial headlines beat stale ones.
            HeadlinesWidgetProvider.refreshAll(applicationContext)
            // And the in-app list, which is looking at the same data.
            PollEvents.publishFinished(stored)
        }
        return Result.success()
    }

    /** Returns how many new articles were stored across all feeds. */
    private fun pollAllFeeds(db: SQLiteDatabase): Int {
        var storedTotal = 0
        val guardianKey = NewsDb.getSetting(db, SettingKeys.GUARDIAN_API_KEY)?.trim()
        val cutoff = System.currentTimeMillis() - TimeUnit.DAYS.toMillis(MAX_ITEM_AGE_DAYS)

        for (feed in enabledFeeds(db)) {
            try {
                val useGuardianApi = !guardianKey.isNullOrEmpty() &&
                    GuardianClient.isGuardianFeed(feed.sourceName, feed.url)

                if (useGuardianApi) {
                    val items = GuardianClient.fetchLatest(guardianKey!!)
                    val stored = storeItems(db, feed, items, cutoff)
                    storedTotal += stored
                    Log.i(TAG, "${feed.sourceName}: Guardian API gave ${items.size}, stored $stored")
                    markFeedOk(db, feed.id, null, null)
                } else {
                    val response = HttpFetch.get(feed.url, feed.etag, feed.lastModified)

                    if (response.notModified) {
                        // FR-1: unchanged feed, nothing to parse.
                        markFeedOk(db, feed.id, feed.etag, feed.lastModified)
                        continue
                    }
                    if (response.status !in 200..299) {
                        markFeedFailed(db, feed, "HTTP ${response.status}")
                        continue
                    }
                    val body = response.body
                    if (body.isNullOrBlank()) {
                        markFeedFailed(db, feed, "Empty response body")
                        continue
                    }

                    val parsed = FeedParser.parse(body)
                    val stored = storeItems(db, feed, parsed.items, cutoff)
                    storedTotal += stored
                    Log.i(
                        TAG,
                        "${feed.sourceName}: parsed ${parsed.items.size} items, stored $stored new"
                    )
                    if (!parsed.title.isNullOrBlank()) {
                        db.execSQL(
                            "UPDATE feeds SET title = ? WHERE id = ? AND (title IS NULL OR title = '')",
                            arrayOf<Any?>(parsed.title, feed.id)
                        )
                    }
                    markFeedOk(db, feed.id, response.etag, response.lastModified)
                }
            } catch (e: MalformedFeedException) {
                // Failure mode table: log, flag the feed, skip this poll.
                Log.w(TAG, "Malformed feed ${feed.url}", e)
                markFeedFailed(db, feed, e.message ?: "Malformed feed")
            } catch (e: Exception) {
                Log.w(TAG, "Feed poll failed ${feed.url}", e)
                markFeedFailed(db, feed, e.message ?: e.javaClass.simpleName)
            }
        }
        return storedTotal
    }

    private fun enabledFeeds(db: SQLiteDatabase): List<FeedRow> {
        val feeds = mutableListOf<FeedRow>()
        db.rawQuery(
            "SELECT id, url, sourceName, lastEtag, lastModified, consecutiveFailures " +
                "FROM feeds WHERE enabled = 1 ORDER BY sortOrder ASC, id ASC",
            null
        ).use { c ->
            while (c.moveToNext()) {
                feeds.add(
                    FeedRow(
                        id = c.getLong(0),
                        url = c.getString(1),
                        sourceName = c.getString(2),
                        etag = c.stringOrNull("lastEtag"),
                        lastModified = c.stringOrNull("lastModified"),
                        consecutiveFailures = c.intOr("consecutiveFailures", 0)
                    )
                )
            }
        }
        return feeds
    }

    /**
     * Inserts new stories. Deduplication is on the normalised URL (spec 6), so
     * the same story from two feeds, or one already saved via the share sheet,
     * collapses onto the existing row rather than creating a second entry.
     */
    private fun storeItems(
        db: SQLiteDatabase,
        feed: FeedRow,
        items: List<ParsedItem>,
        cutoff: Long
    ): Int {
        val now = System.currentTimeMillis()
        var inserted = 0
        var tooOld = 0
        db.beginTransaction()
        try {
            for (item in items) {
                // FR-1: items older than 7 days are discarded on ingest. Items
                // with no date at all are treated as current.
                if (item.publishedAt != null && item.publishedAt < cutoff) {
                    tooOld++
                    continue
                }

                val existingId = db.rawQuery(
                    "SELECT id FROM articles WHERE url = ?",
                    arrayOf(item.url)
                ).use { c -> if (c.moveToFirst()) c.getLong(0) else null }

                if (existingId != null) {
                    // Already known. Only fill in a body we did not have; never
                    // clobber a successful extraction or the read/saved state.
                    if (item.fullContentHtml != null) {
                        db.execSQL(
                            "UPDATE articles SET bodyHtml = ?, extractionState = ?, extractedAt = ? " +
                                "WHERE id = ? AND (bodyHtml IS NULL OR bodyHtml = '')",
                            arrayOf<Any?>(item.fullContentHtml, ExtractionState.OK, now, existingId)
                        )
                    }
                    // A story that arrived first via share now also belongs to a
                    // feed; recording that lets the source filter find it.
                    db.execSQL(
                        "UPDATE articles SET feedId = ? WHERE id = ? AND feedId IS NULL",
                        arrayOf<Any?>(feed.id, existingId)
                    )
                    continue
                }

                val values = ContentValues().apply {
                    put("feedId", feed.id)
                    put("url", item.url)
                    put("title", item.title)
                    put("author", item.author)
                    put("publishedAt", item.publishedAt ?: now)
                    put("sourceName", feed.sourceName)
                    put("excerpt", item.excerpt)
                    put("isSaved", 0)
                    put("isRead", 0)
                    put("isDismissed", 0)
                    put("scrollPosition", 0.0)
                    put("fetchedAt", now)
                    if (item.fullContentHtml != null) {
                        // FR-1: a body in the feed is the preferred path. This
                        // article will never be fetched for extraction.
                        put("bodyHtml", item.fullContentHtml)
                        put("extractionState", ExtractionState.OK)
                        put("extractedAt", now)
                    } else {
                        put("extractionState", ExtractionState.PENDING)
                    }
                }
                val rowId = db.insertWithOnConflict(
                    "articles", null, values, SQLiteDatabase.CONFLICT_IGNORE
                )
                if (rowId > 0) inserted++
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        if (tooOld > 0) Log.i(TAG, "${feed.sourceName}: discarded $tooOld items older than 7 days")
        return inserted
    }

    private fun markFeedOk(db: SQLiteDatabase, feedId: Long, etag: String?, lastModified: String?) {
        db.execSQL(
            "UPDATE feeds SET lastPolledAt = ?, lastEtag = ?, lastModified = ?, " +
                "consecutiveFailures = 0, lastError = NULL WHERE id = ?",
            arrayOf<Any?>(System.currentTimeMillis(), etag, lastModified, feedId)
        )
    }

    /**
     * FR-1: a feed that fails five polls in a row is flagged in settings with
     * its error, but we keep polling it — outages end.
     */
    private fun markFeedFailed(db: SQLiteDatabase, feed: FeedRow, error: String) {
        db.execSQL(
            "UPDATE feeds SET lastPolledAt = ?, consecutiveFailures = consecutiveFailures + 1, " +
                "lastError = ? WHERE id = ?",
            arrayOf<Any?>(System.currentTimeMillis(), error.take(500), feed.id)
        )
    }

    /** FR-10: retention cleanup runs daily as part of the background job. */
    private fun runRetentionIfDue(db: SQLiteDatabase) {
        val last = NewsDb.getSetting(db, SettingKeys.LAST_CLEANUP_AT)?.toLongOrNull() ?: 0L
        val now = System.currentTimeMillis()
        if (now - last < TimeUnit.DAYS.toMillis(1)) return

        Retention.run(applicationContext, db)
        NewsDb.putSetting(db, SettingKeys.LAST_CLEANUP_AT, now.toString())
    }

    companion object {
        private const val TAG = "FeedPollWorker"
        private const val MAX_ITEM_AGE_DAYS = 7L

        /** Process-wide: one poll at a time, whatever enqueued it. */
        private val pollLock = Mutex()
    }
}
