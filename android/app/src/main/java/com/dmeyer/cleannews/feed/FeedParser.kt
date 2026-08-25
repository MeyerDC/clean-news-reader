package com.dmeyer.cleannews.feed

import android.util.Xml
import com.dmeyer.cleannews.data.UrlNormalizer
import org.xmlpull.v1.XmlPullParser
import org.xmlpull.v1.XmlPullParserException
import java.io.StringReader
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** One story as it appeared in the feed document. */
data class ParsedItem(
    val title: String,
    val url: String,
    val publishedAt: Long?,
    val author: String?,
    val excerpt: String?,
    /**
     * Body from <content:encoded> (RSS) or a full <content> (Atom). When this is
     * present FR-1 says we store it and never perform an extraction fetch.
     */
    val fullContentHtml: String?,
    val imageUrl: String?
)

data class ParsedFeed(
    val title: String?,
    val items: List<ParsedItem>
)

class MalformedFeedException(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * Pull parser for RSS 2.0 / RDF and Atom. Namespace processing is left off so
 * prefixed elements arrive as their literal names ("content:encoded"), which is
 * what publishers actually emit and is far less brittle than binding prefixes.
 */
object FeedParser {

    /**
     * FR-1 only lets us skip the extraction fetch when the feed carries "a full
     * article body". Plenty of publishers put a two-sentence teaser and a "Read
     * the full article" link in <content:encoded>, and trusting that would give
     * the reader a stub instead of a story.
     *
     * The bar is FR-4's own definition of a readable article, so a feed body we
     * accept and a fetched body we accept are held to the same standard.
     */
    private const val MIN_FULL_BODY_CHARS = 500

    fun parse(xml: String): ParsedFeed {
        val cleaned = xml.trim().removePrefix("﻿")
        if (cleaned.isEmpty()) throw MalformedFeedException("Feed body was empty")

        // A feed address that has been retired usually answers with the site's
        // HTML rather than a 404. Saying so beats letting the XML parser fail
        // deep inside <head> with a message about an unclosed <link>.
        if (looksLikeHtml(cleaned)) {
            throw MalformedFeedException("That address returns a web page, not a feed")
        }

        val parser = Xml.newPullParser()
        parser.setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, false)
        try {
            parser.setInput(StringReader(cleaned))
        } catch (e: XmlPullParserException) {
            throw MalformedFeedException("Could not read feed XML", e)
        }

        var feedTitle: String? = null
        val items = mutableListOf<ParsedItem>()
        var current: MutableItem? = null

        try {
            var event = parser.eventType
            while (event != XmlPullParser.END_DOCUMENT) {
                when (event) {
                    XmlPullParser.START_TAG -> {
                        val name = parser.name?.lowercase(Locale.ROOT).orEmpty()
                        val item = current
                        if (item != null) {
                            // readItemTag always consumes the whole element, so
                            // the only END_TAG the loop below sees at item level
                            // is the item's own closing tag.
                            readItemTag(parser, name, item)
                        } else when (name) {
                            "item", "entry" -> current = MutableItem()
                            "title" -> if (feedTitle == null) feedTitle = text(parser)
                        }
                    }

                    XmlPullParser.END_TAG -> {
                        val name = parser.name?.lowercase(Locale.ROOT).orEmpty()
                        if (current != null && (name == "item" || name == "entry")) {
                            current.build()?.let { items.add(it) }
                            current = null
                        }
                    }
                }
                event = parser.next()
            }
        } catch (e: XmlPullParserException) {
            // A feed that breaks part-way through still yields the items parsed
            // so far; only a feed we could read nothing from counts as a failure.
            if (items.isEmpty()) throw MalformedFeedException("Malformed feed XML", e)
        } catch (e: Exception) {
            if (items.isEmpty()) throw MalformedFeedException("Could not parse feed", e)
        }

        if (items.isEmpty() && feedTitle == null) {
            throw MalformedFeedException("No feed content found")
        }
        return ParsedFeed(feedTitle, items)
    }

    private fun looksLikeHtml(body: String): Boolean {
        val head = body.take(512).lowercase(Locale.ROOT)
        if (head.startsWith("<!doctype html")) return true
        // Guard against a leading XML declaration or comment before <html>.
        return head.contains("<html") && !head.contains("<rss") && !head.contains("<feed")
    }

    private fun readItemTag(parser: XmlPullParser, name: String, item: MutableItem) {
        when (name) {
            "title" -> item.title = text(parser)

            "link" -> {
                // RSS carries the URL as element text; Atom puts it in @href and
                // may offer several rel values, of which we want "alternate".
                val href = parser.getAttributeValue(null, "href")
                if (href != null) {
                    val rel = parser.getAttributeValue(null, "rel")
                    if (rel == null || rel == "alternate") item.link = href
                    text(parser)
                } else {
                    text(parser)?.let { item.link = it }
                }
            }

            "guid", "id" -> {
                val value = text(parser)
                // A permalink guid is a usable fallback when <link> is missing.
                if (item.link == null && value != null && value.startsWith("http")) {
                    item.link = value
                }
            }

            "pubdate", "published", "dc:date", "issued", "updated" -> {
                val parsed = parseDate(text(parser))
                // "updated" is a weaker signal than an explicit publication date.
                if (parsed != null && (item.publishedAt == null || name != "updated")) {
                    item.publishedAt = parsed
                }
            }

            // Atom nests <author><name>; RSS 2.0 puts an address here directly.
            // text() flattens both to the same string.
            "author", "dc:creator" -> {
                val value = text(parser)
                if (!value.isNullOrBlank()) item.author = value
            }

            "description", "summary" -> item.summary = text(parser)

            // FR-1: a full body in the feed means we never fetch this article.
            "content:encoded" -> item.contentHtml = text(parser)

            "content" -> {
                // type="xhtml" nests real elements, which text() would flatten
                // into tagless prose — better to extract that one properly.
                val type = parser.getAttributeValue(null, "type")
                val value = text(parser)
                if (!value.isNullOrBlank() &&
                    (type == null || type == "html" || type == "text/html")
                ) {
                    item.contentHtml = value
                }
            }

            "enclosure" -> {
                val type = parser.getAttributeValue(null, "type")
                val url = parser.getAttributeValue(null, "url")
                if (url != null && item.imageUrl == null &&
                    (type == null || type.startsWith("image/"))
                ) {
                    item.imageUrl = url
                }
                text(parser)
            }

            "media:content", "media:thumbnail" -> {
                val url = parser.getAttributeValue(null, "url")
                if (url != null && item.imageUrl == null) item.imageUrl = url
                text(parser)
            }

            // Anything else is consumed so its children cannot be mistaken for
            // fields of this item.
            else -> text(parser)
        }
    }

    /** Reads the text of the current element, tolerating CDATA and nesting. */
    private fun text(parser: XmlPullParser): String? {
        return try {
            val builder = StringBuilder()
            var depth = 1
            while (depth > 0) {
                when (parser.next()) {
                    XmlPullParser.START_TAG -> depth++
                    XmlPullParser.END_TAG -> depth--
                    XmlPullParser.TEXT, XmlPullParser.CDSECT ->
                        builder.append(parser.text.orEmpty())
                    XmlPullParser.END_DOCUMENT -> depth = 0
                }
            }
            builder.toString().trim().ifEmpty { null }
        } catch (_: Exception) {
            null
        }
    }

    private val DATE_FORMATS = listOf(
        "EEE, dd MMM yyyy HH:mm:ss zzz",
        "EEE, dd MMM yyyy HH:mm:ss Z",
        "EEE, dd MMM yyyy HH:mm zzz",
        "EEE, dd MMM yyyy HH:mm:ss",
        "dd MMM yyyy HH:mm:ss zzz",
        "yyyy-MM-dd'T'HH:mm:ssXXX",
        "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
        "yyyy-MM-dd'T'HH:mm:ss'Z'",
        "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
        "yyyy-MM-dd'T'HH:mm:ssZ",
        "yyyy-MM-dd HH:mm:ss",
        "yyyy-MM-dd"
    )

    fun parseDate(raw: String?): Long? {
        val value = raw?.trim().orEmpty()
        if (value.isEmpty()) return null
        for (pattern in DATE_FORMATS) {
            try {
                val format = SimpleDateFormat(pattern, Locale.US)
                if (pattern.endsWith("'Z'")) format.timeZone = TimeZone.getTimeZone("UTC")
                format.isLenient = true
                val date: Date = format.parse(value) ?: continue
                return date.time
            } catch (_: Exception) {
                // try the next pattern
            }
        }
        return null
    }

    private class MutableItem {
        var title: String? = null
        var link: String? = null
        var publishedAt: Long? = null
        var author: String? = null
        var summary: String? = null
        var contentHtml: String? = null
        var imageUrl: String? = null

        fun build(): ParsedItem? {
            val url = UrlNormalizer.normalize(link) ?: return null
            val cleanTitle = Html.stripTags(title)?.takeIf { it.isNotBlank() }
                ?: return null

            val bodyLength = Html.textLength(contentHtml)
            val fullBody = contentHtml?.takeIf { bodyLength >= MIN_FULL_BODY_CHARS }
            // A body too short to be the article still makes a decent excerpt
            // when the feed gave us no <description>.
            val excerpt = Html.stripTags(summary)
                ?: if (fullBody == null) Html.stripTags(contentHtml) else null

            return ParsedItem(
                title = cleanTitle,
                url = url,
                publishedAt = publishedAt,
                author = Html.stripTags(author),
                excerpt = excerpt?.take(400),
                fullContentHtml = fullBody,
                imageUrl = imageUrl
            )
        }
    }
}

/** Minimal HTML helpers; the real cleaning happens in the webview (FR-4). */
object Html {
    private val TAG = Regex("<[^>]*>")
    private val WHITESPACE = Regex("\\s+")

    fun stripTags(value: String?): String? {
        if (value.isNullOrBlank()) return null
        val text = TAG.replace(value, " ")
            .replace("&nbsp;", " ")
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&#39;", "'")
            .replace("&apos;", "'")
        return WHITESPACE.replace(text, " ").trim().ifEmpty { null }
    }

    fun textLength(html: String?): Int = stripTags(html)?.length ?: 0
}
