package com.dmeyer.cleannews.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.text.format.DateUtils
import android.widget.RemoteViews
import com.dmeyer.cleannews.MainActivity
import com.dmeyer.cleannews.R
import com.dmeyer.cleannews.data.NewsDb
import com.dmeyer.cleannews.data.SettingKeys
import com.dmeyer.cleannews.feed.PollScheduler

/**
 * FR-3: the home-screen headline list.
 *
 * This runs in the widget host's process with no access to the Capacitor
 * webview, so everything it shows comes straight out of the shared SQLite
 * database that the polling job writes (spec 4.1).
 */
class HeadlinesWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray
    ) {
        appWidgetIds.forEach { id -> renderWidget(context, appWidgetManager, id) }
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)

        // Android cancels an app's PendingIntents when the app is replaced, so
        // after an update every tap on a widget that has not been re-rendered
        // is silently dead. Re-render immediately to hand the launcher live
        // ones again.
        if (intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            refreshAll(context)
            return
        }

        if (intent.action == ACTION_REFRESH) {
            // Header tap: kick a poll and show that something is happening.
            PollScheduler.pollNow(context)
            val manager = AppWidgetManager.getInstance(context)
            manager.getAppWidgetIds(ComponentName(context, HeadlinesWidgetProvider::class.java))
                .forEach { id ->
                    val views = RemoteViews(context.packageName, R.layout.widget_headlines)
                    views.setTextViewText(R.id.widget_subtitle, context.getString(R.string.widget_refreshing))
                    manager.partiallyUpdateAppWidget(id, views)
                }
        }
    }

    private fun renderWidget(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetId: Int
    ) {
        val views = RemoteViews(context.packageName, R.layout.widget_headlines)

        views.setTextViewText(R.id.widget_title, context.getString(R.string.app_name))
        views.setTextViewText(R.id.widget_subtitle, lastRefreshLabel(context))

        // The list itself is served by HeadlinesRemoteViewsService.
        val serviceIntent = Intent(context, HeadlinesRemoteViewsService::class.java).apply {
            putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
            // RemoteViews caches adapters by intent; the widget id in the data
            // URI keeps multiple placed widgets from sharing one factory.
            data = Uri.parse(toUri(Intent.URI_INTENT_SCHEME))
        }
        // Deprecated in favour of the API 31 RemoteCollectionItems overload,
        // which cannot back a list off a database query. minSdk is 26, so the
        // service-backed adapter is still the correct call here.
        @Suppress("DEPRECATION")
        views.setRemoteAdapter(R.id.widget_list, serviceIntent)
        views.setEmptyView(R.id.widget_list, R.id.widget_empty)

        // FR-3: the header doubles as a manual refresh button.
        val refreshIntent = Intent(context, HeadlinesWidgetProvider::class.java).apply {
            action = ACTION_REFRESH
        }
        views.setOnClickPendingIntent(
            R.id.widget_header,
            PendingIntent.getBroadcast(
                context,
                0,
                refreshIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        )
        views.setOnClickPendingIntent(
            R.id.widget_empty,
            PendingIntent.getBroadcast(
                context,
                1,
                refreshIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        )

        // FR-3: tapping a row opens the reader view for that article directly,
        // not the app's home screen. Rows supply the article id as a fill-in.
        val templateIntent = Intent(context, MainActivity::class.java).apply {
            action = MainActivity.ACTION_OPEN_ARTICLE
            // Reuse the single task rather than stacking reader activities.
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        views.setPendingIntentTemplate(
            R.id.widget_list,
            PendingIntent.getActivity(
                context,
                2,
                templateIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
            )
        )

        appWidgetManager.updateAppWidget(appWidgetId, views)
        @Suppress("DEPRECATION")
        appWidgetManager.notifyAppWidgetViewDataChanged(appWidgetId, R.id.widget_list)
    }

    private fun lastRefreshLabel(context: Context): String {
        val db = NewsDb.get(context)
        val last = NewsDb.getSetting(db, SettingKeys.LAST_REFRESH_AT)?.toLongOrNull()
            ?: return context.getString(R.string.widget_never_refreshed)
        val relative = DateUtils.getRelativeTimeSpanString(
            last,
            System.currentTimeMillis(),
            DateUtils.MINUTE_IN_MILLIS,
            DateUtils.FORMAT_ABBREV_RELATIVE
        )
        return context.getString(R.string.widget_updated, relative)
    }

    companion object {
        const val ACTION_REFRESH = "com.dmeyer.cleannews.WIDGET_REFRESH"

        /**
         * Called at the end of every poll (FR-3) and whenever the app changes
         * something the widget shows.
         */
        @JvmStatic
        fun refreshAll(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(
                ComponentName(context, HeadlinesWidgetProvider::class.java)
            )
            if (ids.isEmpty()) return

            // Re-render for the header timestamp, then tell the list its data
            // changed so the factory re-queries.
            val intent = Intent(context, HeadlinesWidgetProvider::class.java).apply {
                action = AppWidgetManager.ACTION_APPWIDGET_UPDATE
                putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids)
            }
            context.sendBroadcast(intent)
        }
    }
}
