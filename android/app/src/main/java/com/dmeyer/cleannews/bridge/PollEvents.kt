package com.dmeyer.cleannews.bridge

/**
 * Lets the webview know a background poll finished.
 *
 * Without this the in-app list would only discover new articles when the user
 * navigated back to it or pulled to refresh — the widget would be current while
 * the app it belongs to showed stale headlines.
 */
object PollEvents {

    private var listener: ((Int) -> Unit)? = null

    @Synchronized
    fun setListener(callback: ((Int) -> Unit)?) {
        listener = callback
    }

    /**
     * Called at the end of every poll run. [storedCount] is how many new
     * articles landed, so the UI can stay quiet when nothing changed.
     */
    @Synchronized
    fun publishFinished(storedCount: Int) {
        listener?.invoke(storedCount)
    }
}
