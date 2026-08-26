/**
 * The contract a sync service has to satisfy.
 *
 * Deliberately narrow. A sync service is a *bridge*: it carries the feed list
 * and read state between devices, and nothing else. Extraction, images,
 * typography, retention, the widget and search all stay local, because those
 * are what this app is for and no service does them the way we want.
 *
 * Keeping the surface this small is also what keeps the service swappable.
 * NewsBlur is the first implementation, not the design.
 */
export interface RemoteFeed {
  /** The service's identifier, stored in feeds.remoteId. */
  remoteId: string;
  /** The feed address itself, which is what a local poll would use. */
  url: string;
  title: string;
}

export interface RemoteStory {
  /** The service's identifier, stored in articles.remoteHash. */
  hash: string;
  remoteFeedId: string;
  url: string;
  title: string;
  author: string | null;
  publishedAt: number | null;
  excerpt: string | null;
  isRead: boolean;
}

export interface SyncSnapshot {
  feeds: RemoteFeed[];
  stories: RemoteStory[];
  /** Hashes the service considers unread, so local state can be reconciled. */
  unreadHashes: string[];
}

/** Who we are talking to, so a switched account is noticed. */
export interface SyncIdentity {
  userId: string;
  username: string;
}

export interface SyncBridge {
  readonly provider: string;

  /** Exchanges credentials for a session. Throws with a readable message. */
  logIn(username: string, password: string): Promise<SyncIdentity>;

  /** Confirms the stored session is still valid and still the same account. */
  whoAmI(): Promise<SyncIdentity | null>;

  /** Everything needed for one reconciliation pass. */
  pull(): Promise<SyncSnapshot>;

  /** Pushes locally-read stories. Returns the hashes the service accepted. */
  pushRead(hashes: string[]): Promise<string[]>;

  /**
   * Subscribes the account to a feed. Returns the service's id for it, or null
   * when the service accepted the call but told us nothing identifiable — the
   * next pull adopts it by URL in that case.
   */
  addFeed(url: string, title?: string): Promise<string | null>;

  /** Unsubscribes the account from a feed. */
  removeFeed(remoteId: string, url: string): Promise<void>;

  logOut(): Promise<void>;
}
