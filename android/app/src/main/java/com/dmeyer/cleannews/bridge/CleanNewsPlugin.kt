package com.dmeyer.cleannews.bridge

import com.dmeyer.cleannews.data.NewsDb
import com.dmeyer.cleannews.data.Retention
import com.dmeyer.cleannews.data.Schema
import com.dmeyer.cleannews.feed.PollScheduler
import com.dmeyer.cleannews.widget.HeadlinesWidgetProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * The Angular layer's window onto the parts of the app that must be native:
 * intent routing, the WorkManager schedule, the widget, and the image cache on
 * disk.
 */
@CapacitorPlugin(name = "CleanNews")
class CleanNewsPlugin : Plugin() {

    override fun load() {
        // From here on, intents are delivered live instead of being parked.
        IntentRouter.setListener { route -> notifyListeners(EVENT_INTENT, route) }
        PollEvents.setListener { stored ->
            notifyListeners(EVENT_POLL_FINISHED, JSObject().put("stored", stored))
        }
    }

    override fun handleOnDestroy() {
        IntentRouter.setListener(null)
        PollEvents.setListener(null)
        super.handleOnDestroy()
    }

    /**
     * Called once as Angular boots. Returns the intent that launched the app —
     * a widget tap or a share — so the app can open on the right screen instead
     * of the home list (FR-3, FR-8).
     */
    @PluginMethod
    fun consumePendingIntent(call: PluginCall) {
        val route = IntentRouter.consumePending()
        val result = JSObject()
        result.put("route", route)
        call.resolve(result)
    }

    /** FR-9 pull-to-refresh: enqueue an immediate poll. */
    @PluginMethod
    fun pollNow(call: PluginCall) {
        PollScheduler.pollNow(context)
        call.resolve()
    }

    /**
     * Called after the poll interval changes in settings so the new cadence
     * takes effect immediately rather than at the next period boundary (FR-11).
     */
    @PluginMethod
    fun reschedulePolling(call: PluginCall) {
        PollScheduler.schedule(context, replace = true)
        call.resolve(JSObject().put("intervalMinutes", PollScheduler.configuredIntervalMinutes(context)))
    }

    /** Keeps the widget honest after in-app reads, dismissals and deletes. */
    @PluginMethod
    fun refreshWidget(call: PluginCall) {
        HeadlinesWidgetProvider.refreshAll(context)
        call.resolve()
    }

    /** FR-11: total cache size shown in settings. */
    @PluginMethod
    fun getCacheSize(call: PluginCall) {
        call.resolve(JSObject().put("bytes", Retention.cacheSizeBytes(context)))
    }

    /** FR-10: clear cache, which never deletes saved articles. */
    @PluginMethod
    fun clearCache(call: PluginCall) {
        val db = NewsDb.get(context)
        val removed = Retention.clearCache(context, db)
        HeadlinesWidgetProvider.refreshAll(context)
        call.resolve(JSObject().put("removed", removed))
    }

    /** FR-6: "Delete from cache" for one article, files included. */
    @PluginMethod
    fun deleteArticle(call: PluginCall) {
        val id = call.getLong("articleId")
        if (id == null || id <= 0) {
            call.reject("articleId is required")
            return
        }
        val db = NewsDb.get(context)
        Retention.deleteArticles(context, db, listOf(id))
        HeadlinesWidgetProvider.refreshAll(context)
        call.resolve()
    }

    /**
     * The logical database name the webview should open, so the Angular layer
     * cannot drift from the file the native side writes (spec 4.1).
     */
    @PluginMethod
    fun getDatabaseName(call: PluginCall) {
        call.resolve(
            JSObject()
                .put("name", Schema.DB_NAME)
                .put("imageDir", Retention.IMAGE_DIR)
        )
    }

    companion object {
        const val EVENT_INTENT = "appIntent"
        const val EVENT_POLL_FINISHED = "pollFinished"
    }
}
