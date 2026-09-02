/** Mirrors the `feeds` table (spec section 6). */
export interface Feed {
  id: number;
  url: string;
  title: string | null;
  sourceName: string;
  enabled: boolean;
  sortOrder: number;
  lastPolledAt: number | null;
  lastEtag: string | null;
  lastModified: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  /** Newest item seen on the last poll — null for feeds carrying no dates. */
  lastItemAt: number | null;
  /** When this feed last actually produced a new article. Observed, not guessed. */
  lastNewArticleAt: number | null;
  /** The sync service's identifier for this feed, when one is linked. */
  remoteId: string | null;
}

export type ExtractionState =
  | 'pending'
  | 'ok'
  | 'failed_paywall'
  /** The page's substance is a player, not prose. */
  | 'failed_video'
  | 'failed_other';

/** Mirrors the `articles` table (spec section 6). */
export interface Article {
  id: number;
  feedId: number | null;
  url: string;
  title: string;
  author: string | null;
  publishedAt: number | null;
  sourceName: string | null;
  excerpt: string | null;
  leadImagePath: string | null;
  bodyHtml: string | null;
  extractionState: ExtractionState;
  isSaved: boolean;
  isRead: boolean;
  isDismissed: boolean;
  /**
   * Read, then aged out of the cache. Its images are gone and it no longer
   * appears in the list, but its text is kept so search can still find it.
   */
  isArchived: boolean;
  archivedAt: number | null;
  scrollPosition: number;
  fetchedAt: number | null;
  extractedAt: number | null;
  /** When the row was last written into the search index. */
  indexedAt: number | null;
  /** The sync service's identifier, when the story came from one. */
  remoteHash: string | null;
  /** A local read not yet acknowledged by the sync service. */
  readPushPending: boolean;
  /** Pipe-wrapped lowercased feed categories: "|sport|maverick news|". */
  categories: string | null;
  /**
   * The image the feed advertised, still a remote URL. Distinct from
   * leadImagePath, which is a cached file and only exists once the article has
   * been extracted — that is, once it has been opened.
   */
  imageUrl: string | null;
  /**
   * When the article was read. Null while unread, and null for rows read
   * before this column existed.
   */
  readAt: number | null;
}

/**
 * A topic is a rule evaluated against articles, not a label attached to feeds.
 *
 * Feed-level topics do not work: Daily Maverick sits in a general-interest feed
 * and occasionally writes about rugby, so inheriting the feed's topic would
 * file that piece under the wrong heading. Equally, keywords alone cannot
 * express "Tech", because the four feeds that are most about tech publish no
 * categories and their vocabulary is too generic to match on.
 *
 * So the clauses are OR'd: whole single-subject feeds, per-article categories,
 * and finally keywords for the feeds that offer nothing else.
 */
export interface Topic {
  id: number;
  name: string;
  sortOrder: number;
  /** Every article from these feeds matches — for single-subject feeds. */
  feedIds: number[];
  /** Matched against articles.categories. */
  categories: string[];
  /** Matched against the search index. Fuzziest clause, used last. */
  keywords: string[];
}

/** Mirrors the `cached_images` table (spec section 6). */
export interface CachedImage {
  id: number;
  articleId: number;
  remoteUrl: string;
  localPath: string | null;
  width: number | null;
  height: number | null;
  caption: string | null;
}

/** FR-9 list filters. */
export type ArticleFilter =
  | { kind: 'all' }
  | { kind: 'unread' }
  | { kind: 'saved' }
  | { kind: 'source'; sourceName: string }
  | { kind: 'topic'; topicId: number };

export const FEED_FAILURE_THRESHOLD = 5;
