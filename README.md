# Koppie & Print

A personal Android news reader that shows the article and nothing else.

Headlines arrive through a home-screen widget or the in-app list; any article
URL can also be pushed in from the Android share sheet. Tapping through renders
the extracted article body — text and images only — with a route to the original
page always available. Everything that has ever passed through is searchable,
and sharing an article from a new site offers to follow its feed.

Single user. No accounts, no sync, no backend. Installed by sideload or a
personal Play Console track.

## Running it

```bash
npm install
npm run build          # Angular bundle into www/
npx cap sync android   # copy web assets + plugins into the Android project
cd android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

`npm test` runs the unit suite (Vitest via the Angular builder). `npm run lint`
runs eslint.

Requires JDK 21 and an Android SDK with API 36 platform + build tools.

## Architecture

The load-bearing constraint is that the widget runs in a different process from
the Capacitor webview and cannot call into Angular. Both sides therefore talk to
one SQLite file that the native layer owns.

```
                       ┌──────────────────────────────┐
   WorkManager ───────▶│  cleannewsSQLite.db          │◀─────── Angular
   FeedPollWorker      │  feeds / articles /          │         (webview)
   (Kotlin, app        │  cached_images / settings    │
    closed or open)    └──────────────────────────────┘
                                    ▲
                                    │
                       HeadlinesRemoteViewsService
                       (widget list rows)
```

* **Feed polling never lives in Angular.** It is a Kotlin `CoroutineWorker`
  scheduled through `WorkManager`, so headlines keep arriving with the app shut.
* **The schema is defined twice, on purpose** — `data/Schema.kt` and
  `core/db.service.ts` — because either side may be the first to open the file.
  Every statement is `IF NOT EXISTS`. Keep them identical.
* **URL normalisation is also mirrored** in `data/UrlNormalizer.kt` and
  `core/url.ts`. It is the article identity used for deduplication, so the two
  must agree exactly or one story is stored twice.
* **All publisher HTTP goes through the native layer** (`HttpFetch.kt` for
  feeds, `CapacitorHttp` for extraction and images). The webview's `fetch` is
  subject to CORS and would be blocked by most publisher origins.

### Native layer (`android/app/src/main/java/com/dmeyer/cleannews/`)

| Area | Files |
|---|---|
| Shared storage | `data/Schema.kt`, `data/NewsDb.kt`, `data/Retention.kt` |
| Article identity | `data/UrlNormalizer.kt` |
| Polling | `feed/FeedPollWorker.kt`, `feed/FeedParser.kt`, `feed/HttpFetch.kt`, `feed/PollScheduler.kt`, `feed/GuardianClient.kt` |
| Widget | `widget/HeadlinesWidgetProvider.kt`, `widget/HeadlinesRemoteViewsService.kt` |
| Bridge to Angular | `bridge/CleanNewsPlugin.kt`, `bridge/IntentRouter.kt`, `bridge/PollEvents.kt` |

### Web layer (`src/app/`)

| Area | Files |
|---|---|
| Storage + settings | `core/db.service.ts`, `core/settings.service.ts` |
| Search | `core/search.service.ts` (FTS5 index, ranking, snippets) |
| Feed discovery | `core/feed-discovery.service.ts` |
| Extraction | `core/extraction.service.ts` (Readability + DOMPurify + allow-list) |
| Images | `core/image-cache.service.ts` |
| Orchestration | `core/article.service.ts`, `core/feed.service.ts`, `core/poll.service.ts` |
| Startup + intents | `core/bootstrap.service.ts`, `core/intent.service.ts` |
| Screens | `home/`, `reader/`, `settings/` |

## Search

SQLite's FTS5, running entirely on device. The Capacitor SQLite plugin ships
SQLCipher, which bundles its own SQLite 3.53 with the full FTS5 stack — bm25
ranking, `snippet()` highlighting, the porter stemmer, prefix and phrase
queries. Because it is bundled rather than the system SQLite, that is identical
on every device regardless of Android version.

Two depths, and the difference matters:

* **Headline and summary for every article.** 100% coverage, no extra
  downloads — that text already arrives with the feed.
* **Full text for every article you have opened.** Extraction is lazy, so a
  body only exists once you have read the article.

**The index lives on the webview side only.** The Kotlin poll job runs against
whatever SQLite the device shipped with, which may have no FTS5 at all, so it
cannot maintain the index and FTS triggers are out. Instead every article
carries `indexedAt` and `SearchService.catchUp()` picks up whatever the poll
wrote, on app start and on each `pollFinished` event.

### The amendment to FR-10

The original retention rule deleted read articles after two days, which meant
reading something made it vanish *faster* than ignoring it — the articles most
worth searching for were the first to go. Retention now splits:

| | Before | Now |
|---|---|---|
| Unread, past 7 days | deleted | deleted (unchanged) |
| **Read, past 2 days** | **deleted** | **archived** — images released, text kept |
| Saved | kept | kept (unchanged) |

An archived article leaves the list and gives up its images, but its text stays
and stays searchable. Opening one renders text-only and deliberately does not
re-acquire the images, so the release is not quietly undone. Cost is roughly
0.25 KB per article that passes through plus ~10 KB per article actually read —
single-digit MB a year.

## Growing the feed list

Sharing an article from a site with no feed yet offers to follow it. The page
was already downloaded to extract the article, so reading its
`<link rel="alternate">` costs nothing; only the fallback makes new requests.

Measured against fifteen publishers, **twelve were discoverable from a shared
article URL** — and only three of those declared the feed in the page. The other
nine were found by probing conventional paths (`/feed`, `/rss`, and the Arc
Publishing path that TimesLIVE uses), which is why `PROBE_PATHS` exists and is
ordered by hit rate.

The three that failed each fail differently: EWN has no feed at all; the BBC has
one but hosts it on `feeds.bbci.co.uk`, which probing an article's own origin
structurally cannot reach; News24 served a bot-block page.

Settings takes a bare domain for the same reason — paste `moneyweb.co.za` and it
finds `moneyweb.co.za/feed`.

**Each feed costs roughly 90 MB/month at the 30-minute default poll interval.**
Only three of seven publishers honour conditional requests, so the rest re-send
the whole feed every cycle. The poll interval matters about 24× more than
anything else in this app's data use.

## Video posts

Roughly 5% of articles are a player with a caption rather than prose —
concentrated in TimesLIVE's `WATCH`/`RECORDED` posts and Daily Maverick's
`/video/` pages. They used to produce two different wrong answers:

* a generic *"couldn't read this one cleanly"*, which is vague when the real
  answer is "this is a video", and
* worse, a **stunted article**: one Daily Maverick video post cleared the
  500-character bar with 692 characters and rendered as two paragraphs with the
  embed silently stripped, giving no hint that the substance was missing.

`og:type` is no help — every video post tested still declares itself an
`article`. The reliable signal is the embed itself, which the sanitiser removes
long before the verdict is reached. So detection runs on the untouched document,
before DOMPurify, and its result feeds the verdict: a page with a player and
less than `VIDEO_MIN_ARTICLE_CHARS` of prose is a video post, not a failed
article.

Three outcomes, all verified against live pages:

| Page | Result |
|---|---|
| Player, no prose | *"This one is a video"* + **Watch on TimesLIVE** |
| Player, 692 chars | same — the character count alone got this one wrong |
| Real article, 6,855 chars, with a video | reads normally, plus a tappable `▶ Video — watch on the original page` block |

**The player stays on the publisher's page.** Embedding it would mean allowing
iframes back into the reader, which is exactly what the sanitiser exists to
prevent. The Custom Tab was already the escape hatch for paywalls and failed
extractions, and it works here for the same reason.

On these pages Readability discards the embed anyway — the player sits outside
the article node it chooses — so for a real article the marker is added after
cleaning. That loses the video's original position but keeps the fact of it.

## Identity

The name is a koppie (a little cup) and a printed page — which is also the
logo, kept in `resources/logo.svg` as the source of truth.

**Icon.** `resources/logo.svg` is converted by hand into two vector drawables:
`ic_launcher_foreground.xml` and `ic_launcher_monochrome.xml`. Both scale the
296x321 artwork by 0.2 and centre it in the 108dp adaptive-icon canvas, which
keeps it inside the 72dp safe zone that survives whatever mask the launcher
applies. The `<monochrome>` layer is what lets Android 13+ tint the icon to the
wallpaper palette.

Two traps, both hit during the build:

* The Capacitor scaffold ships a `drawable-v24/ic_launcher_foreground.xml`, and
  `-v24` outranks plain `drawable/` on every device this app supports — so a new
  icon in `drawable/` is silently ignored until that file is deleted.
* After deleting it, Gradle's incremental resource state reports the
  replacement as missing. `./gradlew :app:clean` clears it.

Because minSdk is 26, the adaptive icon always wins and the legacy launcher
PNGs are unreachable. They are left in place rather than risk a dangling
reference.

**Wordmark.** Playfair Display, weight 700, latin subset only — 38 KB, applied
through `.cn-wordmark` and used nowhere but the app's own name. It is bundled
rather than linked from Google Fonts: the app is expected to work in airplane
mode and should not need a network round-trip to draw its own name. SIL Open
Font License; the licence sits beside the font in `src/assets/fonts/`.

**The widget gets the mark, not the wordmark.** `ic_widget_logo.xml` is the
same artwork at 24dp with `fillColor="@color/widget_text_primary"`, so it
follows light and dark like everything else in the widget.

The wordmark is *not* there, and not for want of trying:
`android:fontFamily="@font/playfair_display"` compiles, resolves, and appears
correctly in the built layout — but the launcher inflates widget layouts in its
own process and will not load a font resource across that boundary, so the text
silently falls back to the system sans. The font file was removed again rather
than ship 300 KB that nothing reads.

If the widget ever needs the real wordmark, the route that works is the one the
icon already uses: export "Koppie & Print" from Figma as SVG **with the text
converted to outlines**, then convert it to a vector drawable the same way. A
path needs no font at runtime, renders identically in any process, and takes a
colour resource so it themes for free.

Playfair is deliberately *not* used for article text. Playfair is a display face and
its hairlines thin out badly at reading sizes, which is the opposite of what
FR-6 asks for — the body stays on the Noto Serif stack, which is built for it.

## Decisions worth knowing

**No write-ahead logging.** `NewsDb` explicitly calls
`disableWriteAheadLogging()`. Two independent SQLite stacks open this file —
Android's `SQLiteDatabase` natively and the Capacitor plugin's own connection in
the webview — and under WAL the most recent writes from the native side went
missing when the other side touched the file. A rollback journal commits
straight into the database file, which both stacks agree on. Nothing is lost:
the widget's `RemoteViewsService` runs in this same process, so there is no
cross-process reader that WAL would have helped.

**Polls are serialised.** The periodic schedule and a manual "refresh now" are
separate pieces of unique work, so WorkManager will happily run them at the same
moment. A process-wide mutex in `FeedPollWorker` makes the second wait.

**A feed body must be a real body.** FR-1 lets us skip the extraction fetch when
a feed carries `<content:encoded>`, but several publishers put a two-sentence
teaser and a "Read the full article" link there. `FeedParser` only accepts a
feed body at or above 500 characters — the same bar `ExtractionService` uses to
call a fetched page readable.

**Schema changes run in three phases.** Tables, then `ADDED_COLUMNS`, then
indexes — in both layers. A personal app is installed over the top of its own
data, so `CREATE TABLE IF NOT EXISTS` is a no-op on an existing database and an
index naming a newly added column would be built before the column exists.
Getting this order wrong crashes every existing install on launch.

**The widget is inflated by the launcher, not by us.** RemoteViews only inflates
classes annotated `@RemoteView`, and only resolves resources from our own
package. So the widget layouts contain no `<View>` (use `FrameLayout`), no
`android:theme`, and no `?attr/` references. The provider also listens for
`ACTION_MY_PACKAGE_REPLACED`, because an app update cancels our PendingIntents
and every widget tap is silently dead until something re-renders it.

**Extraction is cleaned twice.** DOMPurify is the security boundary — scripts,
event handlers, dangerous URL schemes. The tag allow-list after it is the
editorial boundary — what belongs in a reading view. The reader re-runs the
whole pass over stored bodies at render time, so feed-supplied HTML that never
went through `extract()` gets the same treatment.

## Default feeds

Seeded once, then fully editable in Settings without a rebuild.

Working: Daily Maverick, GroundUp, MyBroadband, BusinessTech, IOL, TimesLIVE,
The Guardian.

Seeded **disabled**, with the reason shown in Settings:

* **EWN** — dropped its public RSS feed in a site redesign; every documented
  path now 404s.
* **Reuters** — retired public RSS; the wire is licensed only.

Both still read correctly when their links are shared into the app; only
ingestion is unavailable. Point either row at a working address and enable it.

News24 is deliberately absent, per the requirements: it is substantially
paywalled and would fail extraction on most articles.

## Guardian API (optional)

Paste an Open Platform key into Settings and Guardian articles are fetched from
the API with their full body instead of RSS + extraction, carrying the
attribution the licence requires. Without a key the Guardian is an ordinary
feed. The code path exists and compiles but has not been exercised against a
live key.
