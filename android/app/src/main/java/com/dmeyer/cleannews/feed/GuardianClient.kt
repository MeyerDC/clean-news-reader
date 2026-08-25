package com.dmeyer.cleannews.feed

import com.dmeyer.cleannews.data.UrlNormalizer
import org.json.JSONObject

/**
 * FR-2: when a Guardian Open Platform key is configured we take Guardian
 * articles from the API instead of RSS + extraction. The API hands back the
 * full body, so extraction can never fail for these.
 */
object GuardianClient {

    const val SOURCE_NAME = "The Guardian"

    /** The attribution the Open Platform licence requires us to display. */
    const val ATTRIBUTION_HTML =
        "<p class=\"cn-attribution\">" +
            "Content from The Guardian, supplied via the Guardian Open Platform. " +
            "&copy; Guardian News &amp; Media Limited." +
            "</p>"

    private const val ENDPOINT = "https://content.guardianapis.com/search"

    fun isGuardianFeed(sourceName: String?, url: String?): Boolean =
        sourceName?.equals(SOURCE_NAME, ignoreCase = true) == true ||
            url?.contains("theguardian.com", ignoreCase = true) == true

    /**
     * Returns items already carrying their body, so the caller stores them the
     * same way it stores a feed item with content:encoded.
     */
    fun fetchLatest(apiKey: String, pageSize: Int = 50): List<ParsedItem> {
        val url = buildString {
            append(ENDPOINT)
            append("?api-key=").append(encode(apiKey))
            append("&show-fields=headline,byline,body,thumbnail,trailText,firstPublicationDate")
            append("&order-by=newest")
            append("&page-size=").append(pageSize)
        }

        val response = HttpFetch.get(url, accept = "application/json")
        if (response.status !in 200..299 || response.body.isNullOrBlank()) {
            throw Exception("Guardian API returned HTTP ${response.status}")
        }

        val results = JSONObject(response.body)
            .optJSONObject("response")
            ?.optJSONArray("results")
            ?: return emptyList()

        val items = mutableListOf<ParsedItem>()
        for (i in 0 until results.length()) {
            val result = results.optJSONObject(i) ?: continue
            val webUrl = UrlNormalizer.normalize(result.optString("webUrl").takeIf { it.isNotBlank() })
                ?: continue
            val fields = result.optJSONObject("fields")

            val title = fields?.optString("headline")?.takeIf { it.isNotBlank() }
                ?: result.optString("webTitle").takeIf { it.isNotBlank() }
                ?: continue

            val body = fields?.optString("body")?.takeIf { it.isNotBlank() }
            val published = FeedParser.parseDate(
                fields?.optString("firstPublicationDate")?.takeIf { it.isNotBlank() }
                    ?: result.optString("webPublicationDate")
            )

            items.add(
                ParsedItem(
                    title = Html.stripTags(title) ?: title,
                    url = webUrl,
                    publishedAt = published,
                    author = Html.stripTags(fields?.optString("byline")),
                    excerpt = Html.stripTags(fields?.optString("trailText"))?.take(400),
                    // Attribution travels with the body so it is displayed
                    // wherever the article is rendered.
                    fullContentHtml = body?.let { it + ATTRIBUTION_HTML },
                    imageUrl = fields?.optString("thumbnail")?.takeIf { it.isNotBlank() }
                )
            )
        }
        return items
    }

    private fun encode(value: String): String =
        java.net.URLEncoder.encode(value, "UTF-8")
}
