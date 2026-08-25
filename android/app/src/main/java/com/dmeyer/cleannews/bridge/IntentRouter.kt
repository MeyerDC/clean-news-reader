package com.dmeyer.cleannews.bridge

import com.getcapacitor.JSObject

/**
 * Hands intents from the native side to the Angular router.
 *
 * A widget tap or a share usually arrives during onCreate, long before the
 * webview has loaded Angular and subscribed to anything. Firing an event at
 * that point would drop it on the floor, so routes are parked until the web
 * layer explicitly drains them; only after that do later intents go straight
 * through as live events.
 */
object IntentRouter {

    const val TYPE_ARTICLE = "article"
    const val TYPE_SHARE = "share"
    const val TYPE_SHARE_NO_URL = "shareNoUrl"

    private var pending: JSObject? = null
    private var listener: ((JSObject) -> Unit)? = null

    /** True once Angular has drained the launch intent and is listening. */
    private var webReady = false

    @Synchronized
    fun publish(route: JSObject) {
        val active = listener
        if (webReady && active != null) {
            active(route)
        } else {
            // Only the most recent intent matters; the user is going one place.
            pending = route
        }
    }

    @Synchronized
    fun setListener(callback: ((JSObject) -> Unit)?) {
        listener = callback
        if (callback == null) {
            // The webview went away; the next one has to ask again.
            webReady = false
        }
    }

    /**
     * Returns the parked route, if any, and clears it. Calling this is Angular's
     * way of saying it is now able to receive live events.
     */
    @Synchronized
    fun consumePending(): JSObject? {
        webReady = true
        val route = pending
        pending = null
        return route
    }

    fun article(articleId: Long): JSObject = JSObject()
        .put("type", TYPE_ARTICLE)
        .put("articleId", articleId)

    fun share(url: String): JSObject = JSObject()
        .put("type", TYPE_SHARE)
        .put("url", url)

    fun shareWithoutUrl(): JSObject = JSObject().put("type", TYPE_SHARE_NO_URL)
}
