package com.dmeyer.cleannews.feed

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.dmeyer.cleannews.data.NewsDb
import com.dmeyer.cleannews.data.SettingKeys
import java.util.concurrent.TimeUnit

/**
 * FR-1: polling runs through WorkManager so it continues while the app is
 * closed — which is the whole point of the widget (spec 4.1).
 */
object PollScheduler {

    private const val PERIODIC_WORK = "clean-news-feed-poll"
    private const val ONE_SHOT_WORK = "clean-news-feed-poll-now"

    const val DEFAULT_INTERVAL_MINUTES = 30
    const val MIN_INTERVAL_MINUTES = 15
    const val MAX_INTERVAL_MINUTES = 360

    private val constraints = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()

    fun configuredIntervalMinutes(context: Context): Int {
        val db = NewsDb.get(context)
        val stored = NewsDb.getIntSetting(db, SettingKeys.POLL_INTERVAL_MINUTES, DEFAULT_INTERVAL_MINUTES)
        return stored.coerceIn(MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES)
    }

    /**
     * Idempotent: safe to call on every app start. [replace] is used when the
     * user changes the interval in settings, which must take effect now rather
     * than at some unknown future period boundary.
     */
    fun schedule(context: Context, replace: Boolean = false) {
        val minutes = configuredIntervalMinutes(context).toLong()
        val request = PeriodicWorkRequestBuilder<FeedPollWorker>(minutes, TimeUnit.MINUTES)
            .setConstraints(constraints)
            .build()

        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            PERIODIC_WORK,
            if (replace) ExistingPeriodicWorkPolicy.UPDATE else ExistingPeriodicWorkPolicy.KEEP,
            request
        )
    }

    /** FR-9 pull-to-refresh and the widget's header refresh button. */
    fun pollNow(context: Context) {
        val request = OneTimeWorkRequestBuilder<FeedPollWorker>()
            .setConstraints(constraints)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            ONE_SHOT_WORK,
            ExistingWorkPolicy.KEEP,
            request
        )
    }
}
