package com.dmeyer.cleannews

import android.content.Intent
import android.os.Bundle
import com.dmeyer.cleannews.bridge.CleanNewsPlugin
import com.dmeyer.cleannews.bridge.IntentRouter
import com.dmeyer.cleannews.data.UrlNormalizer
import com.dmeyer.cleannews.feed.PollScheduler
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(CleanNewsPlugin::class.java)
        super.onCreate(savedInstanceState)

        // Idempotent: keeps the background poll alive across reinstalls and
        // "force stop" without ever stacking duplicate work (FR-1).
        PollScheduler.schedule(this)

        routeIntent(intent)
    }

    /**
     * The activity is singleTask, so a widget tap or a share while the app is
     * already running arrives here rather than through onCreate.
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        routeIntent(intent)
    }

    private fun routeIntent(intent: Intent?) {
        if (intent == null) return

        when {
            // FR-3: widget row tap goes straight to the reader for that article.
            intent.action == ACTION_OPEN_ARTICLE || intent.hasExtra(EXTRA_ARTICLE_ID) -> {
                val articleId = intent.getLongExtra(EXTRA_ARTICLE_ID, -1L)
                if (articleId > 0) IntentRouter.publish(IntentRouter.article(articleId))
            }

            // FR-8: share sheet. The shared text is scanned for the first URL.
            intent.action == Intent.ACTION_SEND -> {
                val shared = intent.getStringExtra(Intent.EXTRA_TEXT)
                    ?: intent.getStringExtra(Intent.EXTRA_SUBJECT)
                val url = UrlNormalizer.firstUrlIn(shared)
                    ?: UrlNormalizer.firstUrlIn(intent.dataString)

                if (url != null) {
                    IntentRouter.publish(IntentRouter.share(url))
                } else {
                    IntentRouter.publish(IntentRouter.shareWithoutUrl())
                }
            }
        }

        // Consumed: a configuration change must not replay the same navigation.
        intent.removeExtra(EXTRA_ARTICLE_ID)
        if (intent.action == Intent.ACTION_SEND) intent.action = Intent.ACTION_MAIN
    }

    companion object {
        const val ACTION_OPEN_ARTICLE = "com.dmeyer.cleannews.OPEN_ARTICLE"
        const val EXTRA_ARTICLE_ID = "articleId"
    }
}
