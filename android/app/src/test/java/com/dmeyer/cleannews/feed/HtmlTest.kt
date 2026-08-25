package com.dmeyer.cleannews.feed

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * [Html.stripTags] feeds article titles, authors and excerpts, so anything it
 * lets through is stored and later rendered. These lock in the decode-then-strip
 * order that keeps encoded markup from being rebuilt into live tags.
 */
class HtmlTest {

    @Test
    fun `strips real tags`() {
        assertEquals("Hello world", Html.stripTags("<b>Hello</b> <i>world</i>"))
    }

    @Test
    fun `encoded markup is decoded then stripped, not reconstructed`() {
        // The regression: stripping first left this as text, and the decode
        // pass then turned it back into a live tag.
        assertEquals("", Html.stripTags("&lt;img src=x onerror=alert(1)&gt;") ?: "")
        assertEquals("hi", Html.stripTags("&lt;script&gt;hi&lt;/script&gt;"))
    }

    @Test
    fun `entities are decoded once`() {
        // &amp;lt; is the publisher writing a literal "&lt;", not a tag.
        assertEquals("&lt;b&gt;", Html.stripTags("&amp;lt;b&amp;gt;"))
    }

    @Test
    fun `decodes named, decimal and hex entities`() {
        assertEquals("Tom & Jerry", Html.stripTags("Tom &amp; Jerry"))
        assertEquals("it's", Html.stripTags("it&#39;s"))
        assertEquals("it's", Html.stripTags("it&#x27;s"))
        assertEquals("\"quoted\"", Html.stripTags("&quot;quoted&quot;"))
    }

    @Test
    fun `unknown entities are left alone`() {
        assertEquals("100 &fake; 200", Html.stripTags("100 &fake; 200"))
    }

    @Test
    fun `collapses whitespace including non-breaking spaces`() {
        assertEquals("a b", Html.stripTags("a&nbsp;&nbsp;b"))
        assertEquals("a b", Html.stripTags("a&#160;b"))
        assertEquals("a b", Html.stripTags("  a \n\t b  "))
    }

    @Test
    fun `blank and empty input yield null`() {
        assertNull(Html.stripTags(null))
        assertNull(Html.stripTags("   "))
        assertNull(Html.stripTags("<p></p>"))
    }

    @Test
    fun `rejects surrogate halves and out of range code points`() {
        assertEquals("&#xD800;", Html.stripTags("&#xD800;"))
        assertEquals("&#1114112;", Html.stripTags("&#1114112;"))
    }

    @Test
    fun `textLength measures decoded text`() {
        assertEquals(5, Html.textLength("<p>hello</p>"))
        assertEquals(0, Html.textLength(null))
    }
}
