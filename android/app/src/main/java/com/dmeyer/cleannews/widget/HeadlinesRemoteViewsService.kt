package com.dmeyer.cleannews.widget

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.text.format.DateUtils
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import com.dmeyer.cleannews.MainActivity
import com.dmeyer.cleannews.R
import com.dmeyer.cleannews.data.NewsDb

/** Feeds rows to the widget's ListView straight from the shared database. */
class HeadlinesRemoteViewsService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory =
        HeadlinesFactory(applicationContext)
}

private data class WidgetRow(
    val id: Long,
    val title: String,
    val sourceName: String?,
    val publishedAt: Long?
)

private class HeadlinesFactory(private val context: Context) :
    RemoteViewsService.RemoteViewsFactory {

    private var rows: List<WidgetRow> = emptyList()

    override fun onCreate() = Unit

    /**
     * Called on the binder thread whenever the provider signals a data change,
     * so the query happens here rather than in getViewAt.
     */
    override fun onDataSetChanged() {
        rows = try {
            val db = NewsDb.get(context)
            db.rawQuery(
                """
                SELECT id, title, sourceName, publishedAt
                FROM articles
                WHERE isDismissed = 0 AND isArchived = 0
                ORDER BY COALESCE(publishedAt, fetchedAt, 0) DESC
                LIMIT ?
                """.trimIndent(),
                arrayOf(MAX_ROWS.toString())
            ).use { c ->
                val list = mutableListOf<WidgetRow>()
                while (c.moveToNext()) {
                    list.add(
                        WidgetRow(
                            id = c.getLong(0),
                            title = c.getString(1) ?: continue,
                            sourceName = if (c.isNull(2)) null else c.getString(2),
                            publishedAt = if (c.isNull(3)) null else c.getLong(3)
                        )
                    )
                }
                list
            }
        } catch (_: Exception) {
            // A widget that renders its empty state beats one that crashes the
            // launcher; the next poll will try again.
            emptyList()
        }
    }

    override fun onDestroy() {
        rows = emptyList()
    }

    override fun getCount(): Int = rows.size

    override fun getViewAt(position: Int): RemoteViews {
        val row = rows.getOrNull(position)
            ?: return RemoteViews(context.packageName, R.layout.widget_row)
        val views = RemoteViews(context.packageName, R.layout.widget_row)

        views.setTextViewText(R.id.row_headline, row.title)
        views.setTextViewText(R.id.row_meta, meta(row))

        // FR-3: lands directly in the reader view for this article.
        views.setOnClickFillInIntent(
            R.id.row_root,
            Intent().putExtra(MainActivity.EXTRA_ARTICLE_ID, row.id)
        )
        return views
    }

    /** FR-3 row format: source name and a relative timestamp. */
    private fun meta(row: WidgetRow): String {
        val source = row.sourceName?.takeIf { it.isNotBlank() }
        val time = row.publishedAt?.let {
            DateUtils.getRelativeTimeSpanString(
                it,
                System.currentTimeMillis(),
                DateUtils.MINUTE_IN_MILLIS,
                DateUtils.FORMAT_ABBREV_RELATIVE
            ).toString()
        }
        return listOfNotNull(source, time).joinToString("  ·  ")
    }

    /** Null lets the host show its default placeholder while we query. */
    override fun getLoadingView(): RemoteViews? = null

    override fun getViewTypeCount(): Int = 1

    override fun getItemId(position: Int): Long = rows.getOrNull(position)?.id ?: position.toLong()

    override fun hasStableIds(): Boolean = true

    companion object {
        private const val MAX_ROWS = 50
    }
}
