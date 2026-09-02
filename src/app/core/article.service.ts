import { Injectable, inject, signal } from '@angular/core';
import { Network } from '@capacitor/network';

import { Article, ArticleFilter, ExtractionState } from './models';
import { DbService, fromBool, toBool } from './db.service';
import { ExtractionService } from './extraction.service';
import { ImageCacheService } from './image-cache.service';
import { CleanNews } from './clean-news.plugin';
import { SearchService } from './search.service';
import { TopicService } from './topic.service';
import { hostLabel, normalizeUrl } from './url';

/** Shape stored in SQLite, before booleans are widened. */
type ArticleRow = Omit<
  Article,
  'isSaved' | 'isRead' | 'isDismissed' | 'isArchived' | 'readPushPending'
> & {
  isSaved: number;
  isRead: number;
  isDismissed: number;
  isArchived: number;
  readPushPending: number;
};

/**
 * The result of an explicit download. Images are reported separately because
 * "Load images on mobile data" is off for some people, and a download that
 * quietly skipped every picture while saying "done" would be a lie.
 */
/** One entry in the curated list, with the reason it was chosen. */
export interface CuratedPick {
  article: Article;
  /** 'filler' was picked at random to make the count up to ten. */
  pool: 'recent' | 'filler';
  /** Webview-safe src for the cached thumbnail, null until one is fetched. */
  thumbSrc: string | null;
}

export type DownloadOutcome =
  | { state: 'ok'; images: 'cached' | 'deferred' }
  | { state: 'failed'; reason: 'paywall' | 'other' | 'video'; detail: string }
  | { state: 'offline' };

/** How much of the bar the article's text is worth, before its images. */
const TEXT_SHARE = 0.25;

export type ExtractionOutcome =
  | { state: 'ok' }
  | { state: 'failed'; reason: 'paywall' | 'other' | 'video'; detail: string }
  /** Failure-mode table: offline with nothing cached. Queued for connectivity. */
  | { state: 'offline' };

@Injectable({ providedIn: 'root' })
export class ArticleService {
  /** Bumped whenever the article table changes, so lists can re-read. */
  readonly revision = signal(0);

  /** Article ids whose extraction is waiting for the network to come back. */
  private readonly offlineQueue = new Set<number>();
  private networkListenerAttached = false;

  private readonly db = inject(DbService);
  private readonly extraction = inject(ExtractionService);
  private readonly images = inject(ImageCacheService);
  private readonly search = inject(SearchService);
  private readonly topics = inject(TopicService);

  // ---- reading ----------------------------------------------------------

  /** FR-9: unified list, newest first, with the filter applied in SQL. */
  async list(filter: ArticleFilter, limit = 200): Promise<Article[]> {
    // Archived articles are searchable but not browsable — they are a text
    // record, not a readable cached page.
    // Aliased as `a` because a topic clause is built against that alias.
    const where: string[] = ['a.isDismissed = 0'];
    const params: unknown[] = [];

    // Reading history is the one view that must see archived rows. Archiving is
    // what happens to an article two days after you read it — images released,
    // text kept — so excluding them here would leave a history stretching back
    // exactly two days, which is not a history.
    if (filter.kind !== 'read') where.push('a.isArchived = 0');

    switch (filter.kind) {
      case 'unread':
        where.push('a.isRead = 0');
        break;
      case 'saved':
        where.push('a.isSaved = 1');
        break;
      case 'read':
        where.push('a.isRead = 1');
        break;
      case 'source':
        where.push('a.sourceName = ?');
        params.push(filter.sourceName);
        break;
      case 'topic': {
        const topic = await this.topics.get(filter.topicId);
        const clause = topic ? this.topics.buildClause(topic) : null;
        // A topic with no clauses matches nothing rather than everything —
        // silently showing the whole list would look like the rule worked.
        if (!clause) return [];
        where.push(clause.sql);
        params.push(...clause.params);
        break;
      }
      case 'all':
        break;
    }

    // History is ordered by when you read it, not when it was published: the
    // question it answers is "what was I reading", not "what came out".
    // archivedAt stands in for rows read before readAt existed.
    const order =
      filter.kind === 'read'
        ? 'COALESCE(a.readAt, a.archivedAt, a.publishedAt, a.fetchedAt, 0)'
        : 'COALESCE(a.publishedAt, a.fetchedAt, 0)';

    params.push(limit);
    const rows = await this.db.query<ArticleRow>(
      `SELECT a.* FROM articles a
       WHERE ${where.join(' AND ')}
       ORDER BY ${order} DESC
       LIMIT ?`,
      params,
    );
    return rows.map(hydrate);
  }

  /**
   * FR-3: the curated list — the articles picked for you rather than the ones
   * that arrived last.
   *
   * Read, never written, here. The picks are chosen by the native curator
   * because the widget shows the same list and has to be fed while the app is
   * closed; computing them again in TypeScript would give the two surfaces
   * their own opinion of what the top ten are.
   *
   * Read articles are kept, unlike in the widget. Tapping a card, reading, and
   * coming back to find it gone from under your thumb is worse than seeing it
   * marked as read — the widget drops them because it is a shortlist you work
   * through, which is a different job.
   */
  async curated(limit = 10): Promise<CuratedPick[]> {
    const rows = await this.db.query<ArticleRow & { pool: string; thumbPath: string | null }>(
      `SELECT a.*, p.pool, p.thumbPath FROM curated_picks p
       JOIN articles a ON a.id = p.articleId
       WHERE a.isDismissed = 0 AND a.isArchived = 0
       ORDER BY p.rank
       LIMIT ?`,
      [limit],
    );
    return Promise.all(
      rows.map(async (row) => ({
        article: hydrate(row),
        pool: row.pool === 'filler' ? ('filler' as const) : ('recent' as const),
        // The remote URL is useless here: the page's CSP forbids loading an
        // image from a publisher, which is what keeps the app from announcing
        // your reading to every newsroom you follow. The native side has
        // already fetched the file; this is the same picture, off disk.
        thumbSrc: row.thumbPath ? await this.images.toWebviewSrc(row.thumbPath) : null,
      })),
    );
  }

  /** When the curated list was last rebuilt, for the section's subtitle. */
  async curatedAt(): Promise<number | null> {
    const row = await this.db.queryOne<{ value: string }>(
      `SELECT value FROM settings WHERE key = 'curatedAt'`,
    );
    const at = Number(row?.value);
    return Number.isFinite(at) && at > 0 ? at : null;
  }

  async get(id: number): Promise<Article | null> {
    const row = await this.db.queryOne<ArticleRow>('SELECT * FROM articles WHERE id = ?', [id]);
    return row ? hydrate(row) : null;
  }

  /**
   * The remote URL behind an article's cached lead image. The reader needs it
   * to recognise the same picture when it also appears as the first figure in
   * the body, which most publishers do.
   */
  async leadImageRemoteUrl(articleId: number): Promise<string | null> {
    const row = await this.db.queryOne<{ remoteUrl: string }>(
      `SELECT ci.remoteUrl FROM cached_images ci
       JOIN articles a ON a.id = ci.articleId AND a.leadImagePath = ci.localPath
       WHERE ci.articleId = ?`,
      [articleId],
    );
    return row?.remoteUrl ?? null;
  }

  async findByUrl(url: string): Promise<Article | null> {
    const row = await this.db.queryOne<ArticleRow>('SELECT * FROM articles WHERE url = ?', [url]);
    return row ? hydrate(row) : null;
  }

  /** Source names present in the list, for the FR-9 source filter. */
  async sources(): Promise<string[]> {
    const rows = await this.db.query<{ sourceName: string }>(
      `SELECT DISTINCT sourceName FROM articles
       WHERE isDismissed = 0 AND isArchived = 0
         AND sourceName IS NOT NULL AND sourceName <> ''
       ORDER BY sourceName COLLATE NOCASE ASC`,
    );
    return rows.map((r) => r.sourceName);
  }

  async unreadCount(): Promise<number> {
    const row = await this.db.queryOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM articles WHERE isDismissed = 0 AND isArchived = 0 AND isRead = 0',
    );
    return row?.n ?? 0;
  }

  // ---- share target -----------------------------------------------------

  /**
   * FR-8: a URL arriving from the share sheet becomes an article immediately so
   * the reader has something to open, tagged saved rather than belonging to a
   * feed. If we already know the URL we reuse that row (spec section 6).
   */
  async createFromSharedUrl(rawUrl: string): Promise<Article> {
    const url = normalizeUrl(rawUrl);
    if (!url) throw new Error('That does not look like a link.');

    const existing = await this.findByUrl(url);
    if (existing) {
      // Sharing something in is an explicit act of keeping it.
      if (!existing.isSaved) {
        await this.db.run('UPDATE articles SET isSaved = 1, isDismissed = 0 WHERE id = ?', [
          existing.id,
        ]);
        this.revision.update((n) => n + 1);
        return { ...existing, isSaved: true, isDismissed: false };
      }
      return existing;
    }

    const now = Date.now();
    // sourceName is left null on purpose: extraction knows the publication's
    // real name, and a host like "groundup.org.za" would otherwise win the
    // COALESCE in storeExtraction and stick forever.
    const id = await this.db.insert(
      `INSERT INTO articles
         (feedId, url, title, sourceName, extractionState, isSaved, isRead, isDismissed,
          scrollPosition, fetchedAt, publishedAt)
       VALUES (NULL, ?, ?, NULL, 'pending', 1, 0, 0, 0, ?, ?)`,
      [url, hostLabel(url), now, now],
    );

    this.revision.update((n) => n + 1);
    const created = await this.get(id);
    if (!created) throw new Error('Could not save that link.');
    await this.search
      .indexOne(created.id, created.title, created.excerpt, created.bodyHtml)
      .catch(() => undefined);
    return created;
  }

  // ---- extraction -------------------------------------------------------

  /**
   * FR-4: a URL is only ever extracted once. FR-7: a previous failure is not
   * retried automatically — the reader offers a manual "Try again" instead.
   */
  async ensureExtracted(articleId: number, force = false): Promise<ExtractionOutcome> {
    const article = await this.get(articleId);
    if (!article) return { state: 'failed', reason: 'other', detail: 'Article not found.' };

    if (!force) {
      if (article.extractionState === 'ok' && article.bodyHtml) return { state: 'ok' };
      if (article.extractionState === 'failed_paywall') {
        return { state: 'failed', reason: 'paywall', detail: PAYWALL_DETAIL };
      }
      if (article.extractionState === 'failed_video') {
        return { state: 'failed', reason: 'video', detail: VIDEO_DETAIL };
      }
      if (article.extractionState === 'failed_other') {
        return { state: 'failed', reason: 'other', detail: GENERIC_DETAIL };
      }
    }

    if (!(await this.isOnline())) {
      // Failure-mode table: offline on an uncached article — show the offline
      // state and queue the extraction for the next connectivity.
      this.queueForConnectivity(articleId);
      return { state: 'offline' };
    }

    const result = await this.extraction.extract(article.url);

    if (!result.ok) {
      await this.db.run(
        'UPDATE articles SET extractionState = ?, extractedAt = ? WHERE id = ?',
        [failureState(result.reason), Date.now(), articleId],
      );
      this.revision.update((n) => n + 1);
      return { state: 'failed', reason: result.reason, detail: result.detail };
    }

    await this.storeExtraction(article, result.finalUrl, {
      title: result.title,
      author: result.author,
      publishedAt: result.publishedAt,
      sourceName: result.sourceName,
      excerpt: result.excerpt,
      bodyHtml: result.bodyHtml,
    });

    // FR-5: the lead image is fetched eagerly; body images stream in later,
    // driven by the reader so a long article is not held up by them.
    if (result.leadImageUrl) {
      await this.images.cacheLeadImage(articleId, result.leadImageUrl).catch(() => null);
    }

    // The body is what makes this article worth full-text searching, so the
    // index entry is rewritten now rather than waiting for the next catch-up.
    const indexed = await this.get(articleId);
    if (indexed) {
      await this.search
        .indexOne(indexed.id, indexed.title, indexed.excerpt, indexed.bodyHtml)
        .catch(() => undefined);
    }

    this.revision.update((n) => n + 1);
    return { state: 'ok' };
  }

  private async storeExtraction(
    article: Article,
    finalUrl: string,
    fields: {
      title: string;
      author: string | null;
      publishedAt: number | null;
      sourceName: string;
      excerpt: string | null;
      bodyHtml: string;
    },
  ): Promise<void> {
    // A redirect may have revealed the article's real URL. Adopt it unless
    // another row already owns it, in which case ours keeps the one it has.
    let url = article.url;
    if (finalUrl !== article.url) {
      const clash = await this.db.queryOne<{ id: number }>(
        'SELECT id FROM articles WHERE url = ? AND id <> ?',
        [finalUrl, article.id],
      );
      if (!clash) url = finalUrl;
    }

    await this.db.run(
      `UPDATE articles SET
         url = ?,
         title = ?,
         author = COALESCE(?, author),
         publishedAt = COALESCE(publishedAt, ?),
         sourceName = COALESCE(NULLIF(sourceName, ''), ?),
         excerpt = COALESCE(?, excerpt),
         bodyHtml = ?,
         extractionState = 'ok',
         extractedAt = ?
       WHERE id = ?`,
      [
        url,
        fields.title,
        fields.author,
        fields.publishedAt,
        fields.sourceName,
        fields.excerpt,
        fields.bodyHtml,
        Date.now(),
        article.id,
      ],
    );
  }

  private async isOnline(): Promise<boolean> {
    try {
      return (await Network.getStatus()).connected;
    } catch {
      return true; // Assume online rather than blocking a read on a bad probe.
    }
  }

  /** Retries queued extractions the moment the device is back on a network. */
  private queueForConnectivity(articleId: number): void {
    this.offlineQueue.add(articleId);
    if (this.networkListenerAttached) return;
    this.networkListenerAttached = true;

    Network.addListener('networkStatusChange', async (status) => {
      if (!status.connected || this.offlineQueue.size === 0) return;
      const pending = Array.from(this.offlineQueue);
      this.offlineQueue.clear();
      for (const id of pending) {
        await this.ensureExtracted(id).catch(() => undefined);
      }
    });
  }

  /**
   * Fetches an article ahead of being read, so it is there on a plane or in a
   * tunnel. Extraction and image caching already exist — this is the same work
   * the reader does on open, done early and deliberately.
   *
   * A download is kept: it sets isSaved, so retention's 7-day unread sweep and
   * "Clear cache" both leave it alone. Downloading something for Sunday on a
   * Friday and finding it gone would make the feature untrustworthy.
   */
  async download(
    articleId: number,
    onProgress?: (fraction: number) => void,
  ): Promise<DownloadOutcome> {
    onProgress?.(0);

    // Asking for a download is asking us to try, so a stored failure is
    // retried rather than replayed. A paywall may have lifted, or the page may
    // simply have been broken the day it was first opened.
    const before = await this.get(articleId);
    const retry = !!before?.extractionState.startsWith('failed');

    const extracted = await this.ensureExtracted(articleId, retry);
    if (extracted.state !== 'ok') return extracted;

    const article = await this.get(articleId);
    const bodyHtml = article?.bodyHtml;
    if (!article || !bodyHtml) {
      return { state: 'failed', reason: 'other', detail: GENERIC_DETAIL };
    }

    // Marked kept before the images, so an interrupted download still leaves
    // a readable article behind rather than one the next sweep deletes.
    await this.db.run('UPDATE articles SET isSaved = 1 WHERE id = ?', [articleId]);

    // The text is the article; the pictures are the long tail. Weighting the
    // bar this way means it moves early — fetching the page is one request
    // whose progress we cannot see, while the images are countable.
    onProgress?.(TEXT_SHARE);

    const allowed = await this.images.downloadsAllowed();
    if (allowed) {
      await this.images
        .cacheAll(
          articleId,
          await this.bodyImages(article, bodyHtml),
          undefined,
          (done, total) =>
            onProgress?.(total ? TEXT_SHARE + (1 - TEXT_SHARE) * (done / total) : 1),
        )
        .catch(() => undefined);
    }

    onProgress?.(1);

    this.revision.update((n) => n + 1);
    return { state: 'ok', images: allowed ? 'cached' : 'deferred' };
  }

  /**
   * The images the reader will ask for. cleanBody already reports them, so
   * this runs the same preparation rather than a second parse that could drift
   * from it. The lead image's duplicate copy is skipped because the reader
   * drops that figure instead of rendering the picture twice.
   */
  private async bodyImages(
    article: Article,
    bodyHtml: string,
  ): Promise<{ url: string; caption: string | null }[]> {
    const prepared = this.extraction.cleanBody(bodyHtml, article.url, article.author);

    const leadRemoteUrl = article.leadImagePath
      ? await this.leadImageRemoteUrl(article.id)
      : null;

    let leadDuplicateDropped = false;
    return prepared.images.filter((image) => {
      if (!leadDuplicateDropped && image.url === leadRemoteUrl) {
        leadDuplicateDropped = true;
        return false;
      }
      return true;
    });
  }

  // ---- state changes ----------------------------------------------------

  /** FR-9: read after the reader has been open for five seconds. */
  async markRead(articleId: number): Promise<void> {
    // readPushPending is set only where the story has a remote identity, so a
    // local-only article never queues work that can never be delivered. The
    // flag also protects the local value from being overwritten by the next
    // pull before it has been acknowledged.
    const changed = await this.db.run(
      `UPDATE articles
       SET isRead = 1,
           readAt = ?,
           readPushPending = CASE WHEN remoteHash IS NOT NULL THEN 1 ELSE 0 END
       WHERE id = ? AND isRead = 0`,
      [Date.now(), articleId],
    );
    if (changed > 0) {
      this.revision.update((n) => n + 1);
      await CleanNews.refreshWidget().catch(() => undefined);
    }
  }

  /** FR-6: scroll position is remembered per article. */
  async saveScrollPosition(articleId: number, position: number): Promise<void> {
    await this.db.run('UPDATE articles SET scrollPosition = ? WHERE id = ?', [
      position,
      articleId,
    ]);
  }

  /** FR-9: swipe to dismiss from the list. */
  async dismiss(articleId: number): Promise<void> {
    await this.db.run('UPDATE articles SET isDismissed = 1 WHERE id = ?', [articleId]);
    this.revision.update((n) => n + 1);
    await CleanNews.refreshWidget().catch(() => undefined);
  }

  async undismiss(articleId: number): Promise<void> {
    await this.db.run('UPDATE articles SET isDismissed = 0 WHERE id = ?', [articleId]);
    this.revision.update((n) => n + 1);
    await CleanNews.refreshWidget().catch(() => undefined);
  }

  async setSaved(articleId: number, saved: boolean): Promise<void> {
    await this.db.run('UPDATE articles SET isSaved = ? WHERE id = ?', [
      fromBool(saved),
      articleId,
    ]);
    this.revision.update((n) => n + 1);
  }

  /** FR-6: "Delete from cache". Native side removes the image files too. */
  async deleteFromCache(articleId: number): Promise<void> {
    await CleanNews.deleteArticle({ articleId });
    this.revision.update((n) => n + 1);
  }
}

function failureState(reason: 'paywall' | 'other' | 'video'): ExtractionState {
  if (reason === 'paywall') return 'failed_paywall';
  if (reason === 'video') return 'failed_video';
  return 'failed_other';
}

const PAYWALL_DETAIL = 'This article looks like it is behind a paywall.';
const VIDEO_DETAIL = 'There is no article here — the story is the video.';
const GENERIC_DETAIL = 'There was not enough article text on this page to read.';

function hydrate(row: ArticleRow): Article {
  return {
    ...row,
    extractionState: row.extractionState as ExtractionState,
    isSaved: toBool(row.isSaved),
    isRead: toBool(row.isRead),
    isDismissed: toBool(row.isDismissed),
    isArchived: toBool(row.isArchived),
    readPushPending: toBool(row.readPushPending),
  };
}
