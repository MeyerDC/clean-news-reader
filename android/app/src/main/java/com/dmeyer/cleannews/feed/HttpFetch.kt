package com.dmeyer.cleannews.feed

import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.zip.GZIPInputStream

/**
 * Result of a conditional GET. [notModified] is the 304 case that FR-1 asks us
 * to short-circuit on.
 */
data class FetchResult(
    val status: Int,
    val body: String?,
    val etag: String?,
    val lastModified: String?,
    val finalUrl: String,
    val notModified: Boolean
)

object HttpFetch {

    private const val USER_AGENT =
        "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/120.0 Mobile Safari/537.36 CleanNews/1.0"

    private const val CONNECT_TIMEOUT_MS = 15_000
    private const val READ_TIMEOUT_MS = 20_000
    private const val MAX_BODY_BYTES = 5 * 1024 * 1024
    private const val MAX_REDIRECTS = 5

    /**
     * Conditional GET honouring ETag / Last-Modified (FR-1) and following
     * redirects manually so the caller learns the final URL — feeds routinely
     * hand out tracking redirectors, and the resolved URL is the identity we
     * deduplicate on (spec section 6).
     */
    fun get(
        url: String,
        etag: String? = null,
        lastModified: String? = null,
        accept: String = "application/rss+xml, application/atom+xml, application/xml, text/xml, */*"
    ): FetchResult {
        var currentUrl = url
        var redirects = 0

        while (true) {
            val connection = (URL(currentUrl).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = READ_TIMEOUT_MS
                // We follow redirects ourselves to capture the final URL and to
                // catch http->https hops, which the built-in handler refuses.
                instanceFollowRedirects = false
                setRequestProperty("User-Agent", USER_AGENT)
                setRequestProperty("Accept", accept)
                setRequestProperty("Accept-Encoding", "gzip")
                etag?.let { setRequestProperty("If-None-Match", it) }
                lastModified?.let { setRequestProperty("If-Modified-Since", it) }
            }

            try {
                val status = connection.responseCode

                if (status == HttpURLConnection.HTTP_NOT_MODIFIED) {
                    return FetchResult(status, null, etag, lastModified, currentUrl, true)
                }

                if (status in 300..399) {
                    val location = connection.getHeaderField("Location")
                    if (location.isNullOrBlank() || redirects >= MAX_REDIRECTS) {
                        return FetchResult(status, null, null, null, currentUrl, false)
                    }
                    currentUrl = URL(URL(currentUrl), location).toString()
                    redirects++
                    continue
                }

                val stream = if (status in 200..299) connection.inputStream else connection.errorStream
                val body = stream?.let { raw ->
                    val decoded =
                        if (connection.contentEncoding?.contains("gzip", true) == true) {
                            GZIPInputStream(raw)
                        } else {
                            raw
                        }
                    decoded.use { readBounded(it, connection.contentType) }
                }

                return FetchResult(
                    status = status,
                    body = body,
                    etag = connection.getHeaderField("ETag"),
                    lastModified = connection.getHeaderField("Last-Modified"),
                    finalUrl = currentUrl,
                    notModified = false
                )
            } finally {
                connection.disconnect()
            }
        }
    }

    /**
     * Bytes rather than text, for the widget's thumbnails. Separate from [get]
     * because that one decodes to a String on the assumption the body is a
     * feed, which would corrupt a JPEG beyond recognition.
     *
     * Returns null on anything unexpected: a missing thumbnail costs one grey
     * frame in a list, which is not worth failing a poll over.
     */
    fun getBytes(url: String, maxBytes: Int): ByteArray? {
        var currentUrl = url
        var redirects = 0

        while (true) {
            val connection = (URL(currentUrl).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = READ_TIMEOUT_MS
                instanceFollowRedirects = false
                setRequestProperty("User-Agent", USER_AGENT)
                setRequestProperty("Accept", "image/avif,image/webp,image/*,*/*;q=0.8")
            }

            try {
                val status = connection.responseCode
                if (status in 300..399) {
                    val location = connection.getHeaderField("Location")
                    if (location.isNullOrBlank() || redirects >= MAX_REDIRECTS) return null
                    currentUrl = URL(URL(currentUrl), location).toString()
                    redirects++
                    continue
                }
                if (status !in 200..299) return null

                return connection.inputStream.use { stream ->
                    val buffer = ByteArrayOutputStream()
                    val chunk = ByteArray(16 * 1024)
                    while (true) {
                        val read = stream.read(chunk)
                        if (read <= 0) break
                        buffer.write(chunk, 0, read)
                        // Checked while reading rather than after: a publisher
                        // serving a 20MB hero image should cost us the read, not
                        // the memory.
                        if (buffer.size() > maxBytes) return null
                    }
                    buffer.toByteArray()
                }
            } catch (_: Exception) {
                return null
            } finally {
                connection.disconnect()
            }
        }
    }

    private fun readBounded(stream: java.io.InputStream, contentType: String?): String {
        val buffer = ByteArrayOutputStream()
        val chunk = ByteArray(16 * 1024)
        var total = 0
        while (true) {
            val read = stream.read(chunk)
            if (read == -1) break
            total += read
            if (total > MAX_BODY_BYTES) break
            buffer.write(chunk, 0, read)
        }
        return buffer.toString(charsetFor(contentType))
    }

    private fun charsetFor(contentType: String?): String {
        val declared = contentType
            ?.split(";")
            ?.map { it.trim() }
            ?.firstOrNull { it.startsWith("charset=", ignoreCase = true) }
            ?.substringAfter("=")
            ?.trim('"', ' ')
        return when {
            declared.isNullOrBlank() -> "UTF-8"
            // Guard against a charset name the JVM does not know.
            runCatching { java.nio.charset.Charset.forName(declared) }.isSuccess -> declared
            else -> "UTF-8"
        }
    }
}
