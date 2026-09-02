package com.dmeyer.cleannews.data

/**
 * The single schema definition for the database that the Kotlin background job,
 * the widget process and the Angular layer all share (spec 4.1).
 *
 * The file lives where @capacitor-community/sqlite expects it — that plugin
 * appends "SQLite.db" to the logical database name — so that the webview and
 * the native side open literally the same file.
 */
object Schema {
    const val DB_NAME = "cleannews"
    const val DB_FILE = DB_NAME + "SQLite.db"

    /**
     * Every statement is idempotent: whichever side starts first wins.
     *
     * Tables and indexes are separate because an index may name a column that
     * ADDED_COLUMNS has yet to add — on an existing database the CREATE TABLE
     * is skipped, so the index would be built against a column that is not
     * there. Open order is: tables, then missing columns, then indexes.
     */
    val TABLE_STATEMENTS: List<String> = listOf(
        """
        CREATE TABLE IF NOT EXISTS feeds (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url TEXT NOT NULL UNIQUE,
            title TEXT,
            sourceName TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            sortOrder INTEGER NOT NULL DEFAULT 0,
            lastPolledAt INTEGER,
            lastEtag TEXT,
            lastModified TEXT,
            consecutiveFailures INTEGER NOT NULL DEFAULT 0,
            lastError TEXT,
            -- Publication date of the newest item seen on the last poll. An
            -- archive feed parses perfectly and reports no error, so this is
            -- what distinguishes "healthy" from "hasn't published since 2021".
            lastItemAt INTEGER,
            -- When this feed last actually produced a new article. Observed
            -- rather than inferred, and the only signal that works for feeds
            -- carrying no dates at all.
            lastNewArticleAt INTEGER
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS articles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            feedId INTEGER,
            url TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            author TEXT,
            publishedAt INTEGER,
            sourceName TEXT,
            excerpt TEXT,
            leadImagePath TEXT,
            bodyHtml TEXT,
            extractionState TEXT NOT NULL DEFAULT 'pending',
            isSaved INTEGER NOT NULL DEFAULT 0,
            isRead INTEGER NOT NULL DEFAULT 0,
            isDismissed INTEGER NOT NULL DEFAULT 0,
            scrollPosition REAL NOT NULL DEFAULT 0,
            fetchedAt INTEGER,
            extractedAt INTEGER,
            -- An article that has been read and has since aged out of the
            -- cache. Its images are gone and it no longer appears in the list,
            -- but its text is kept so search can still reach it.
            isArchived INTEGER NOT NULL DEFAULT 0,
            archivedAt INTEGER,
            -- Set by the web layer once the row is in the search index.
            indexedAt INTEGER
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS cached_images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            articleId INTEGER NOT NULL,
            remoteUrl TEXT NOT NULL,
            localPath TEXT,
            width INTEGER,
            height INTEGER,
            caption TEXT
        )
        """,
        // A topic is a rule over articles, not a tag on a feed. Only the web
        // layer evaluates it, but the definition lives here with the rest.
        """
        CREATE TABLE IF NOT EXISTS topics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            sortOrder INTEGER NOT NULL DEFAULT 0,
            feedIds TEXT,
            categories TEXT,
            keywords TEXT
        )
        """,
        // A feed deleted locally while a sync account is linked. Without it the
        // next pull re-adds the feed: the service still has it, and "absent
        // locally" is indistinguishable from "not yet pulled".
        """
        CREATE TABLE IF NOT EXISTS deleted_feeds (
            remoteId TEXT PRIMARY KEY,
            url TEXT NOT NULL,
            deletedAt INTEGER NOT NULL
        )
        """,
        // Settings live in the database rather than in Preferences because the
        // WorkManager job needs the poll interval, the Guardian key and the
        // retention window without going through the webview.
        "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)"
    )

    /** Run only after ADDED_COLUMNS has brought the table up to date. */
    val INDEX_STATEMENTS: List<String> = listOf(
        "CREATE INDEX IF NOT EXISTS idx_articles_published ON articles (publishedAt DESC)",
        "CREATE INDEX IF NOT EXISTS idx_articles_feed ON articles (feedId)",
        "CREATE INDEX IF NOT EXISTS idx_articles_list ON articles (isDismissed, isArchived, publishedAt DESC)",
        "CREATE INDEX IF NOT EXISTS idx_articles_indexed ON articles (indexedAt)",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_images_article_url ON cached_images (articleId, remoteUrl)"
    )

    /**
     * Default feeds from the requirements table (FR-1). Seeded once, then fully
     * user-editable (FR-11); the seed only runs when the table is empty.
     *
     * News24 is deliberately absent — the spec excludes it as substantially
     * paywalled, and it would fail extraction on most articles.
     */
    val DEFAULT_FEEDS: List<SeedFeed> = listOf(
        SeedFeed("https://www.dailymaverick.co.za/dmrss/", "Daily Maverick"),
        SeedFeed(
            // EWN dropped its public RSS feed in a site redesign; every
            // documented path now 404s. Seeded disabled with the reason
            // visible in settings rather than silently failing five polls in
            // a row on first run. EWN articles still read fine when shared in.
            "https://ewn.co.za/RSS%20Feeds/Latest%20News",
            "EWN",
            enabled = false,
            note = "EWN no longer publishes a public RSS feed. Enable this if " +
                "you find a working address, or share EWN links into the app."
        ),
        SeedFeed("https://www.groundup.org.za/sitenews/rss/", "GroundUp"),
        SeedFeed("https://mybroadband.co.za/news/feed", "MyBroadband"),
        SeedFeed("https://businesstech.co.za/news/feed/", "BusinessTech"),
        SeedFeed("https://www.iol.co.za/rss", "IOL"),
        SeedFeed("https://www.timeslive.co.za/arc/outboundfeeds/rss/?outputType=xml", "TimesLIVE"),
        SeedFeed("https://www.theguardian.com/world/rss", "The Guardian"),
        SeedFeed(
            // Reuters retired public RSS; the wire is licensed only.
            "https://www.reutersagency.com/feed/",
            "Reuters",
            enabled = false,
            note = "Reuters retired its public RSS feeds. Enable this if you " +
                "have a licensed feed address to point it at."
        )
    )

    /**
     * Columns added after the first release, applied on open when missing.
     * A personal app is installed over the top of its own data rather than
     * reinstalled clean, so the schema has to be able to catch up.
     */
    val ADDED_COLUMNS: List<Pair<String, String>> = listOf(
        "isArchived" to "ALTER TABLE articles ADD COLUMN isArchived INTEGER NOT NULL DEFAULT 0",
        "archivedAt" to "ALTER TABLE articles ADD COLUMN archivedAt INTEGER",
        "indexedAt" to "ALTER TABLE articles ADD COLUMN indexedAt INTEGER",
        // The sync service's identifier for this story, needed to push read
        // state back. Null for anything the app fetched by itself.
        "remoteHash" to "ALTER TABLE articles ADD COLUMN remoteHash TEXT",
        // Set when a local read has not yet been acknowledged by the service.
        "readPushPending" to "ALTER TABLE articles ADD COLUMN readPushPending INTEGER NOT NULL DEFAULT 0",
        // Pipe-delimited and pipe-wrapped, lowercased: "|sport|maverick news|".
        // The wrapping pipes let a rule match a whole category exactly with
        // LIKE '%|sport|%' rather than catching "sports betting" by accident.
        "categories" to "ALTER TABLE articles ADD COLUMN categories TEXT",
        // The image the feed advertised, kept as a remote URL rather than a
        // file. leadImagePath cannot serve here: it is only written during
        // extraction, so it exists exactly for articles that have been opened
        // — the opposite of the set a curated list is built from.
        "imageUrl" to "ALTER TABLE articles ADD COLUMN imageUrl TEXT",
        // When the article was read. isRead alone cannot say whether an
        // interest is current or historical, which is the distinction the
        // curator is built on.
        "readAt" to "ALTER TABLE articles ADD COLUMN readAt INTEGER"
    )

    /** Same idea for the feeds table. */
    val ADDED_FEED_COLUMNS: List<Pair<String, String>> = listOf(
        "lastItemAt" to "ALTER TABLE feeds ADD COLUMN lastItemAt INTEGER",
        "lastNewArticleAt" to "ALTER TABLE feeds ADD COLUMN lastNewArticleAt INTEGER",
        // Identity of this feed on the sync service, when one is linked.
        "remoteId" to "ALTER TABLE feeds ADD COLUMN remoteId TEXT"
    )
}

/** One entry in the seeded feed list. */
data class SeedFeed(
    val url: String,
    val sourceName: String,
    val enabled: Boolean = true,
    /** Shown as the feed's status in settings when we already know it is dead. */
    val note: String? = null
)

/** Setting keys shared with the Angular layer (src/app/core/settings.service.ts). */
object SettingKeys {
    const val POLL_INTERVAL_MINUTES = "pollIntervalMinutes"
    const val GUARDIAN_API_KEY = "guardianApiKey"
    const val THEME = "theme"
    const val FONT_SIZE = "fontSize"
    const val LIST_DENSITY = "listDensity"
    const val IMAGES_ON_MOBILE_DATA = "imagesOnMobileData"
    const val LAST_REFRESH_AT = "lastRefreshAt"
    const val LAST_CLEANUP_AT = "lastCleanupAt"
    const val FEEDS_SEEDED = "feedsSeeded"

    /** Sync. Empty provider means local-only, which is the default. */
    const val SYNC_PROVIDER = "syncProvider"
    const val SYNC_ACCOUNT = "syncAccount"
    /** The service's own user id, so a changed identity is detected. */
    const val SYNC_REMOTE_USER = "syncRemoteUser"
    const val SYNC_LAST_AT = "syncLastAt"
}

/** Values of articles.extractionState. */
object ExtractionState {
    const val PENDING = "pending"
    const val OK = "ok"
    const val FAILED_PAYWALL = "failed_paywall"
    /** The page's substance is a video player, not prose. Set by the web layer. */
    const val FAILED_VIDEO = "failed_video"
    const val FAILED_OTHER = "failed_other"
}
