package com.dmeyer.cleannews.data

import android.net.Uri
import java.util.Locale

/**
 * Normalises an article URL so the same story arriving via a feed and via the
 * share sheet collapses onto one row (spec section 6).
 *
 * The Angular layer mirrors this exactly in src/app/core/url.ts — if you change
 * a rule here, change it there too, or the two sides will disagree about
 * identity and create duplicates.
 */
object UrlNormalizer {

    /** Tracking parameters that never change which article you are looking at. */
    private val TRACKING_PARAMS = setOf(
        "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
        "utm_id", "utm_name", "utm_reader", "utm_brand", "utm_social",
        "utm_social-type", "utm_swu",
        "fbclid", "gclid", "gclsrc", "dclid", "msclkid", "twclid", "igshid",
        "mc_cid", "mc_eid", "_ga", "_gl", "yclid", "wbraid", "gbraid",
        "ref", "ref_src", "ref_url", "referrer", "source", "cmpid", "CMP",
        "sfnsn", "spm", "at_medium", "at_campaign", "at_custom1",
        "at_custom2", "at_custom3", "at_custom4", "ito", "ns_campaign",
        "ns_mchannel", "ns_source", "ns_linkname", "ns_fee", "smid",
        "partner", "shareToken", "__twitter_impression", "guccounter",
        "guce_referrer", "guce_referrer_sig"
    )

    private val TRACKING_PREFIXES = listOf("utm_", "at_custom", "pk_", "piwik_", "hsa_")

    fun normalize(raw: String?): String? {
        val trimmed = raw?.trim().orEmpty()
        if (trimmed.isEmpty()) return null

        val uri = try {
            Uri.parse(trimmed)
        } catch (_: Exception) {
            return null
        }

        val scheme = uri.scheme?.lowercase(Locale.ROOT) ?: return null
        if (scheme != "http" && scheme != "https") return null
        val host = uri.host?.lowercase(Locale.ROOT)?.removeSuffix(".") ?: return null
        if (host.isEmpty()) return null

        // Drop the default port so :443 and the implicit port compare equal.
        val port = uri.port
        val authority = when {
            port == -1 -> host
            scheme == "http" && port == 80 -> host
            scheme == "https" && port == 443 -> host
            else -> "$host:$port"
        }

        // Trailing slashes are not meaningful for article paths, but "/" is.
        var path = uri.encodedPath.orEmpty()
        if (path.length > 1) path = path.trimEnd('/')
        if (path.isEmpty()) path = "/"

        val keptParams = uri.queryParameterNames
            .filterNot { isTracking(it) }
            .sorted()
            .flatMap { name ->
                uri.getQueryParameters(name).map { value -> name to value }
            }

        val builder = StringBuilder()
        builder.append(scheme).append("://").append(authority).append(path)
        if (keptParams.isNotEmpty()) {
            builder.append('?')
            builder.append(
                keptParams.joinToString("&") { (n, v) ->
                    if (v.isEmpty()) Uri.encode(n) else "${Uri.encode(n)}=${Uri.encode(v)}"
                }
            )
        }
        // The fragment is always dropped: #comments and #main are the same page.
        return builder.toString()
    }

    private fun isTracking(name: String): Boolean {
        val lower = name.lowercase(Locale.ROOT)
        if (TRACKING_PARAMS.any { it.lowercase(Locale.ROOT) == lower }) return true
        return TRACKING_PREFIXES.any { lower.startsWith(it) }
    }

    /** Pulls the first http(s) URL out of arbitrary shared text (FR-8). */
    fun firstUrlIn(text: String?): String? {
        if (text.isNullOrBlank()) return null
        val match = Regex("""https?://[^\s<>"')\]]+""").find(text) ?: return null
        // Shared text often ends a sentence right after the link.
        val cleaned = match.value.trimEnd('.', ',', ';', ':', '!', '?')
        return normalize(cleaned)
    }
}
