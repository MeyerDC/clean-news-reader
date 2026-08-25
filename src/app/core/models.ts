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
  | { kind: 'source'; sourceName: string };

export const FEED_FAILURE_THRESHOLD = 5;
