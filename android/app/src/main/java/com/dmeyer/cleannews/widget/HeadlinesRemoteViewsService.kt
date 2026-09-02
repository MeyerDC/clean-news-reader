package com.dmeyer.cleannews.widget

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.text.format.DateUtils
import android.util.TypedValue
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import com.dmeyer.cleannews.MainActivity
import com.dmeyer.cleannews.R
import com.dmeyer.cleannews.data.NewsDb
import java.io.File

/** Feeds rows to the widget's ListView straight from the shared database. */
class HeadlinesRemoteViewsService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory =
        HeadlinesFactory(applicationContext)
}

private data class WidgetRow(
    val id: Long,
    val title: String,
    val sourceName: String?,
    val publishedAt: Long?,
    /** Relative to filesDir. Non-null only for curated rows with a picture. */
    val thumbPath: String?,
    val curated: Boolean
)

private class HeadlinesFactory(private val context: Context) :
    RemoteViewsService.RemoteViewsFactory {

    private var rows: List<WidgetRow> = emptyList()

    /** FR-9 density, read with the rows so both surfaces stay in step. */
    private var density: String = "medium"

    /** Decoded thumbnails by article id, refreshed with the rows. */
    private val thumbs = mutableMapOf<Long, Bitmap>()

    override fun onCreate() = Unit

    /**
     * Called on the binder thread whenever the provider signals a data change,
     * so the query happens here rather than in getViewAt.
     */
    override fun onDataSetChanged() {
        rows = try {
            val db = NewsDb.get(context)

            // FR-3: the curated picks first, then everything else by date. Read
            // picks drop out here rather than at curation, so an article opened
            // in the app leaves the widget on the next redraw and a reserve
            // takes its place with its thumbnail already on disk.
            val picks = if (curatedEnabled(db)) {
                db.rawQuery(
                    """
                    SELECT a.id, a.title, a.sourceName, a.publishedAt, p.thumbPath
                    FROM curated_picks p
                    JOIN articles a ON a.id = p.articleId
                    WHERE a.isRead = 0 AND a.isDismissed = 0 AND a.isArchived = 0
                    ORDER BY p.rank
                    LIMIT ?
                    """.trimIndent(),
                    arrayOf(VISIBLE_PICKS.toString())
                ).use { c -> c.readRows(curated = true) }
            } else {
                emptyList()
            }

            // Only the picks actually shown are excluded. Reserves that did not
            // make the cut still belong in the list below at their own date.
            val exclude = picks.joinToString(",") { it.id.toString() }.ifEmpty { "0" }
            val rest = db.rawQuery(
                """
                SELECT id, title, sourceName, publishedAt, NULL
                FROM articles
                WHERE isDismissed = 0 AND isArchived = 0
                  AND id NOT IN ($exclude)
                ORDER BY COALESCE(publishedAt, fetchedAt, 0) DESC
                LIMIT ?
                """.trimIndent(),
                arrayOf(MAX_ROWS.toString())
            ).use { c -> c.readRows(curated = false) }

            picks + rest
        } catch (_: Exception) {
            // A widget that renders its empty state beats one that crashes the
            // launcher; the next poll will try again.
            emptyList()
        }

        density = try {
            NewsDb.getSetting(NewsDb.get(context), "listDensity") ?: "medium"
        } catch (_: Exception) {
            "medium"
        }

        // Decoded once per data change rather than per getViewAt: the launcher
        // asks for the same row repeatedly while scrolling, and decoding a JPEG
        // on the binder thread each time is what makes a widget list stutter.
        thumbs.values.forEach { it.recycle() }
        thumbs.clear()
        rows.forEach { row ->
            val path = row.thumbPath ?: return@forEach
            val file = File(context.filesDir, path)
            if (!file.exists()) return@forEach
            // RGB_565, not the default ARGB_8888. Every one of these crosses a
            // binder call into the launcher and counts against the host's
            // bitmap budget — roughly 1.5 screens' worth of pixels for the
            // whole widget — and a list of ten was using most of it. There is
            // no alpha in a photograph, so the second byte buys nothing.
            val options = BitmapFactory.Options().apply {
                inPreferredConfig = Bitmap.Config.RGB_565
            }
            runCatching { BitmapFactory.decodeFile(file.absolutePath, options) }
                .getOrNull()
                ?.let { thumbs[row.id] = it }
        }
    }

    /**
     * The widget follows the app's list density. RemoteViews cannot restyle a
     * layout, but it can set a text size and a padding on one, which is the
     * whole of the effect here — so this stays two layouts rather than six.
     *
     * The thumbnail keeps its 52dp box at every tier: changing a view's layout
     * size from RemoteViews needs setViewLayoutHeight, which is API 31, and
     * minSdk here is 26.
     */
    private fun applyDensity(views: RemoteViews) {
        val (headline, meta, padY) = when (density) {
            "small" -> Triple(12.5f, 10f, 6)
            "large" -> Triple(16.5f, 12f, 14)
            else -> Triple(14f, 11f, 10)
        }
        views.setTextViewTextSize(R.id.row_headline, TypedValue.COMPLEX_UNIT_SP, headline)
        views.setTextViewTextSize(R.id.row_meta, TypedValue.COMPLEX_UNIT_SP, meta)
        val x = dp(14)
        val y = dp(padY)
        views.setViewPadding(R.id.row_root, x, y, x, y)
    }

    private fun dp(value: Int): Int =
        (value * context.resources.displayMetrics.density).toInt()

    /** Honours the app's "For you" switch; the widget shows what the app shows. */
    private fun curatedEnabled(db: SQLiteDatabase): Boolean =
        NewsDb.getSetting(db, "curatedEnabled") != "0"

    private fun Cursor.readRows(curated: Boolean): List<WidgetRow> {
        val list = mutableListOf<WidgetRow>()
        while (moveToNext()) {
            list.add(
                WidgetRow(
                    id = getLong(0),
                    title = getString(1) ?: continue,
                    sourceName = if (isNull(2)) null else getString(2),
                    publishedAt = if (isNull(3)) null else getLong(3),
                    thumbPath = if (isNull(4)) null else getString(4),
                    curated = curated
                )
            )
        }
        return list
    }

    override fun onDestroy() {
        rows = emptyList()
        thumbs.values.forEach { it.recycle() }
        thumbs.clear()
    }

    override fun getCount(): Int = rows.size

    override fun getViewAt(position: Int): RemoteViews {
        val row = rows.getOrNull(position)
            ?: return RemoteViews(context.packageName, R.layout.widget_row)

        val thumb = thumbs[row.id]
        // The picture layout is used only when there is a picture to put in it.
        // Two of the seeded feeds publish none at all, so a curated row with an
        // empty frame would be a regular sight rather than an edge case.
        val layout = if (row.curated && thumb != null) R.layout.widget_row_pick else R.layout.widget_row
        val views = RemoteViews(context.packageName, layout)

        views.setTextViewText(R.id.row_headline, row.title)
        views.setTextViewText(R.id.row_meta, meta(row))
        applyDensity(views)
        if (thumb != null && layout == R.layout.widget_row_pick) {
            views.setImageViewBitmap(R.id.row_thumb, thumb)
        }

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

    // Plain row and picture row. The launcher recycles by type, so this must
    // count both or it reuses a view that has no ImageView to fill.
    override fun getViewTypeCount(): Int = 2

    override fun getItemId(position: Int): Long = rows.getOrNull(position)?.id ?: position.toLong()

    override fun hasStableIds(): Boolean = true

    companion object {
        private const val MAX_ROWS = 50

        /** How many curated picks sit above the chronological list. */
        private const val VISIBLE_PICKS = 10
    }
}
