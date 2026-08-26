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

## Topics

A topic is a rule evaluated against articles, not a label attached to feeds —
and that is the whole design. Daily Maverick sits in a general-interest feed and
writes about rugby roughly once a cycle; a feed-level topic would file that
piece under South Africa and nowhere else.

Three clauses, OR'd:

| Clause | Matches | For |
|---|---|---|
| **Whole feeds** | every article from the chosen feeds | single-subject feeds — MyBroadband only writes about tech |
| **Categories** | `articles.categories` | publishers that send `<category>`, which is most of them |
| **Keywords** | the FTS5 index | the feeds that send no categories at all |

OR rather than AND: a rugby piece in a general feed carries the category but not
the feed, and requiring both would file it nowhere. `buildTopicClause()` is a
pure function so the list query, the count and the editor's live preview all run
exactly the same rule.

**Categories are captured by the poller**, from RSS `<category>` element text
and Atom `term` attributes, lowercased and stored pipe-delimited *and*
pipe-wrapped: `|sport|maverick news|`. The wrapping pipes are what let a rule
match a whole value — `LIKE '%|sport|%'` will not catch a category called
"sports betting". Daily Maverick packs several categories into one element
("Maverick Life,Johannesburg"), so element text is split on commas first.

Categories are written on insert only. Articles stored before this shipped carry
none and will not gain any; they age out inside the retention window.

**The editor previews itself.** A keyword rule is fuzzy by nature, and tuning one
blind on a phone would be miserable, so the count and the five most recent
matching headlines update on every change. The pick-list of categories is drawn
from what the feeds have actually published, with counts, capped at the twelve
busiest — a few hundred articles produce a long tail of one-offs, and burying
the keyword field under 380 of them makes the last rule the hardest to reach.

Topics appear on the home screen behind a `[ Sources | Topics ]` switch, which
only appears once a topic exists.

## Downloading an article

Swipe a row right. The end side is already dismiss, so the two gestures stay
apart.

Nothing new is fetched or parsed — `ensureExtracted()` and
`ImageCacheService.cacheAll()` are the same calls the reader makes when you open
an article. Download just runs them early, so text and body images are both on
disk before you lose signal. An article opened offline with no download shows
the offline state instead; with one, it renders in full, pictures included.

A download **is kept**: it sets `isSaved`, which retention's 7-day unread sweep
and "Clear cache" both skip. Downloading something on Friday for a Sunday
flight and finding it gone would make the feature not worth using. "Remove from
saved" in the reader's menu puts it back under normal retention.

Two details that came out of using it:

* **An explicit download retries a stored failure** rather than replaying it.
  Asking for a download is asking us to try; the paywall may have lifted, or
  the page may simply have been broken the day it was first opened.
* **The progress bar is real, not a spinner.** Fetching the page is one request
  we cannot see inside, so it is worth a fixed 25%; the images are countable
  and fill the rest. `cacheAll` reports after every *attempt*, not every
  success — a bar stuck at 80% because one picture 404'd would look hung.

If "Load images on mobile data" is off and you are on cellular, the text is
saved and the toast says so rather than claiming the article is ready.

### Telling anyone it exists

A swipe nobody is told about is the same as no feature. Two places, because
they catch different people:

* **A one-time peek.** On the first list that has anything in it, the top row
  opens far enough to show the download button, holds, and closes. The rows
  exist as data before they exist as components, so the query is polled briefly
  rather than read once; the "seen" flag is set only once there is a row to
  demonstrate on, and before the animation, so an interrupted hint does not
  replay forever.
* **A line on the offline screen.** Someone standing in front of an article
  they cannot read is the one moment the gesture explains itself, and it
  catches anyone who missed the peek.

## Chrome that carries no class names

The selector list in `JUNK_SELECTORS` handles publishers who label their
furniture — `class="share-buttons"`, `id="newsletter"`. Some do not label
anything. Jacaranda FM ships its article body with **no class attributes at
all**, so every selector missed and Readability kept the lot: the timestamp
strip, two share widgets, the follow-us lists, the recommendation rail and the
site footer. Twenty-one images, of which two were photographs.

So there is a second set of passes that recognise furniture by shape:

| Pass | What it uses |
|---|---|
| Asset images | Path and extension. SVG is the strongest signal — press photography is raster — plus a path or filename naming an icon, logo, badge or button, plus declared dimensions ≤ 64px |
| `dropTrailingRail` | A "More from…" / "Related" / "Read more" heading, then **everything after it to the end of the document**, climbing out through every ancestor |
| `dropLinkOnlyBlocks` | The share of a short block's text that sits inside anchors, and — for lists — the share of `<li>`s that contain a link |
| `dropOrphanLabels` | A short label ending in ":" with nothing visible after it, and standalone picture credits |
| `markSocialEmbeds` | A blockquote whose text is mostly @handles and #hashtags: an embed that did not load, replaced by a marker rather than deleted |

Three of those were wrong on the first attempt, in ways worth keeping written
down:

* **The rail cut stopped at the heading's own container.** The rail is a
  `<section>` and the site footer follows *that*, so the copyright line stayed
  in the article. It now climbs to the root.
* **An emptied wrapper still counts as a sibling.** The label before the rail
  never looked like the last thing on the page, because the hollow `<section>`
  was still sitting after it.
* **A list that mixes links with plain entries defeats a text ratio.** "94.2"
  and "DStv 858" carry no link and drag the ratio below any threshold, while
  the list is still plainly a directory. Lists are judged per item instead.

`dropLeadingByline` also had a pre-existing sharp edge: `/\bpublished\b/`
matched any short opening sentence containing the word, so "The report,
published on Tuesday, found that…" was eaten as a date line. The metadata
patterns are anchored to the start of the block now.

Result on that article: 9,873 characters of stored body down to 2,991, all of
the difference furniture. Five tests in `extraction.furniture.spec.ts` cover
the other half of the job — that ordinary journalism, including paragraphs with
links, reporting lists and headings that are not rails, comes through untouched.

### Two failures found by testing other sites

**A subscription pitch dressed as reporting.** EWN publishes no feed, so its
articles only ever arrive through the share sheet. Its markup is otherwise
clean, and exactly one thing survived every rule: "Never miss a major story.
Get breaking news…", in its own `<article>` after the story, set in bold
italics. No links once the form is stripped, no label, no class — nothing for
the other passes to hold. `dropTrailingPromos` matches the *act of
subscribing* rather than any publisher's wording, and only in the tail: an
article about a newsletter launch uses the same words, and there the giveaway
is that the reporting carries on afterwards.

**A listicle that extracted into a plausible stub.** A BuzzFeed shopping post
came through as 1,393 characters: the introduction, the "Why Trust BuzzFeed
Shopping?" disclosure and the author bio. None of the 36 products. It read like
a complete short article, which is worse than an obvious failure — nothing on
screen said anything was missing.

The content was in the HTML all along. Readability's link-density penalty
discards the item blocks, because each product carries its own affiliate links.
Readability's own remedy is to re-parse with that cleaning relaxed, but it only
does so when the first result falls under `charThreshold` — and ours was set to
250, so a 1,393-character stub was accepted as a finished article.

The retry is now made explicitly: when a first parse comes back under 2,500
characters it is tried again with the cleaning relaxed, and the second result
is taken **only if it is at least 1.5× longer**, so an ordinary short article
is never swapped for a slightly junkier parse of itself. That post now extracts
at 93,952 characters with its products and reviews intact, while the EWN and
Citizen articles re-extract byte-for-byte identical.

## What a list row shows

A row was headline, then a grey attribution line, then the excerpt — three text
blocks in three different greys, with the attribution interrupting the read. It
is now headline, excerpt, attribution: content as one block, then a quiet
footer. Supporting text shares a single tone, so a row has two levels rather
than three.

The bigger win was in the headlines themselves. Publishers put furniture in
them — Daily Maverick leads with a section in capitals ("WHAT'S COOKING:"),
RugbyPass trails a series ("| Flight Centre Series 2026"), the Guardian trails
a newsletter ("| First Thing"). At headline size and weight that shouts, and in
a list of forty it is most of what the eye lands on.

`splitHeadline()` lifts the leading section into a small letter-spaced kicker
and drops the trailing branding. It recognises a kicker by **case, not
position**: the prefix must contain no lowercase at all. That one rule is what
separates "PARLIAMENT:" from "Plum:", "Damian McKenzie:" and "'We felt the
pressure':" without a per-publisher list. It refuses to split an all-capitals
headline, which would otherwise donate its first clause and keep shouting the
rest.

The split is **display-only**. The stored title keeps every word, so search
still matches what the publisher wrote and the article view still shows it
whole.

## List density

Three tiers, stored as `listDensity` and applied as a class on the content
element so the list, the search results and the empty states all move together.
Medium is the baseline the row styles define; Small and Large adjust it rather
than restating a row, so a change to the row itself still reaches all three.

Small **drops** the excerpt rather than shrinking it. A two-line summary set any
smaller stops being readable and becomes texture — the compact tier exists to
fit more headlines on screen, not more text.

A grid tier is not here yet, and it is not a styling job: rows carry no
thumbnail. Lead images are fetched during extraction, which is lazy, so most
unread articles have no image to show and a grid of them would be mostly empty
boxes. It needs a feed-time thumbnail pass first.

## Sync is two-way for feeds

Pulling was the easy half. NewsBlur's feeds are adopted into the local list
(matched on URL as well as `remoteId`, so a feed already followed locally is
adopted rather than duplicated) — but for a while nothing went the other way,
so a feed added on the phone stayed on the phone.

Both directions now exist, and they are deliberately not symmetrical:

* **Adding is confirmed, never silent.** Subscribing an account writes to
  something the user reads on another machine, and it can surface there minutes
  later. `SyncService.pendingFeedPushes()` finds enabled local feeds with no
  `remoteId`; the settings screen names them and asks. Declining is not
  remembered — the offer returns on the next sync, because the alternative is
  two lists quietly drifting apart. Disabled feeds are never offered: the dead
  seeds (EWN, Reuters) are kept locally as a note to the user, and subscribing
  someone's account to a feed we know is dead is not sync, it is litter.
* **Deleting needs a tombstone.** "Absent locally" is indistinguishable from
  "not pulled yet", so without one the next pull simply re-adds what was just
  deleted. `deleted_feeds` records the removal, the push runs *before* the pull,
  and the row is dropped only once the service acknowledges — a failed push is
  retried rather than leaving the two lists disagreeing forever. Unlinking
  clears the table: a tombstone is an instruction to a service we have stopped
  talking to.

Two NewsBlur responses are treated as success rather than failure, both for the
same reason — the requested state is already true: `add_url` reporting *already
subscribed*, and `delete_feed` reporting a feed it cannot find. Failing either
would keep re-offering work that is done.

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

## Feed health

A feed can return 200, parse perfectly, report no error — and deliver nothing,
because every item is older than FR-1's seven-day ingest cutoff. That is the
most confusing state the app can be in, and SAnews is the case that found it:
the site's only declared feed is `rss-old.xml`, an archive last updated in 2021,
while the live feed sits unmentioned at `/rss.xml`.

**Validity is answerable in one request** — reachable, parses as a feed rather
than HTML, has entries, entries carry a title and a resolvable link, https.

**Liveness is not.** It can only be estimated, and the metric that works is
**cadence**: the date span divided by the number of entries. Newest-date alone
is not enough — a blog posting once a year with one recent post looks fresh.
Measured across real feeds, cadence separates a newsroom from an archive by
three orders of magnitude (0.4 days/item versus 292).

So the app estimates at add time and then *observes*: `feeds.lastItemAt` records
the newest item seen, `feeds.lastNewArticleAt` records when the feed last
actually produced something. The second is the only signal that works for feeds
carrying no dates at all, and it is free because the app polls anyway.

### Discovery ranks by recency, not size

When a site offers several feeds, something has to pick the default. It used to
be item count, which is actively wrong: GroundUp's Q&A section carries 20
entries against its news feed's 15, so size hands you the wrong one.

Discovery now believes a *fresh* declared feed immediately — one request, the
same cost as before — and only probes further when the declared feed is stale or
missing. Candidates are then ranked by health and recency. This is not optional
polish: fixing SAnews requires collecting more candidates, which is exactly what
makes a bad tiebreak start to bite.

Pickers label candidates by freshness rather than size, because "10 items" and
"10 items" tells you nothing when one of them stopped in 2021.

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
