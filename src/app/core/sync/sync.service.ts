import { Injectable, inject, signal } from '@angular/core';

import { DbService } from '../db.service';
import { NewsBlurBridge } from './newsblur.bridge';
import { SyncBridge, SyncIdentity, SyncSnapshot } from './sync.types';

/** Mirrors android/.../data/Schema.kt (SettingKeys). */
const Keys = {
  provider: 'syncProvider',
  account: 'syncAccount',
  remoteUser: 'syncRemoteUser',
  lastAt: 'syncLastAt',
} as const;

/** A local feed the service does not have yet. */
export interface PendingFeedPush {
  id: number;
  url: string;
  sourceName: string;
}

export interface SyncState {
  provider: string | null;
  account: string | null;
  lastSyncedAt: number | null;
}

/**
 * Reconciles the local database against a sync service.
 *
 * **No credential is stored.** The session lives in the HTTP cookie jar; if it
 * lapses, the app asks for the password again rather than keeping one on disk.
 * NewsBlur has no OAuth without a client ID issued by its maintainer, so the
 * alternative would be storing a real password to replay — and a reading app
 * has no business holding that.
 *
 * Local-first remains the default: with no provider linked, nothing here runs
 * and the app polls publishers exactly as before.
 */
@Injectable({ providedIn: 'root' })
export class SyncService {
  private readonly db = inject(DbService);
  private readonly newsblur = inject(NewsBlurBridge);

  readonly state = signal<SyncState>({ provider: null, account: null, lastSyncedAt: null });
  readonly syncing = signal(false);

  private bridgeFor(provider: string | null): SyncBridge | null {
    return provider === this.newsblur.provider ? this.newsblur : null;
  }

  async load(): Promise<SyncState> {
    const [provider, account, remoteUser, lastAt] = await Promise.all([
      this.db.getSetting(Keys.provider),
      this.db.getSetting(Keys.account),
      this.db.getSetting(Keys.remoteUser),
      this.db.getSetting(Keys.lastAt),
    ]);

    this.newsblur.useAccount(remoteUser);
    const next: SyncState = {
      provider: provider || null,
      account: account || null,
      lastSyncedAt: lastAt ? Number(lastAt) : null,
    };
    this.state.set(next);
    return next;
  }

  get linked(): boolean {
    return !!this.state().provider;
  }

  async link(provider: string, username: string, password: string): Promise<SyncIdentity> {
    const bridge = this.bridgeFor(provider);
    if (!bridge) throw new Error('That service is not supported.');

    const identity = await bridge.logIn(username, password);
    await Promise.all([
      this.db.putSetting(Keys.provider, provider),
      this.db.putSetting(Keys.account, identity.username),
      this.db.putSetting(Keys.remoteUser, identity.userId),
    ]);
    this.state.set({ provider, account: identity.username, lastSyncedAt: null });
    return identity;
  }

  async unlink(): Promise<void> {
    const bridge = this.bridgeFor(this.state().provider);
    await bridge?.logOut().catch(() => undefined);

    await Promise.all([
      this.db.putSetting(Keys.provider, ''),
      this.db.putSetting(Keys.account, ''),
      this.db.putSetting(Keys.remoteUser, ''),
    ]);
    // Local feeds and articles are deliberately left alone: unlinking stops the
    // syncing, it does not throw away what you already have.
    await this.db.run('UPDATE feeds SET remoteId = NULL');
    // A tombstone is an instruction to a service we are no longer talking to.
    await this.db.run('DELETE FROM deleted_feeds');
    // So are story hashes. Left behind, they belong to the account that just
    // went away — and the next link would push one account's identifiers to
    // another account, which is not ours to do even between two accounts the
    // same person owns.
    await this.db.run('UPDATE articles SET remoteHash = NULL, readPushPending = 0');
    this.state.set({ provider: null, account: null, lastSyncedAt: null });
  }

  /**
   * One full pass: push what we read, push what we deleted, pull what changed.
   *
   * Feed *additions* are deliberately not part of this. Pushing a feed writes
   * to someone's account and can surface on their laptop minutes later, so it
   * waits for an explicit confirmation — see pendingFeedPushes / pushFeeds.
   */
  async sync(): Promise<{ feeds: number; articles: number; pushed: number }> {
    const bridge = this.bridgeFor(this.state().provider);
    if (!bridge || this.syncing()) return { feeds: 0, articles: 0, pushed: 0 };

    this.syncing.set(true);
    try {
      const pushed = await this.pushReadState(bridge);
      // Before the pull, or the pull re-adds what was just deleted.
      await this.pushDeletions(bridge);
      const snapshot = await bridge.pull();
      const { feeds, articles } = await this.applySnapshot(snapshot);
      await this.applyRemoteReads(snapshot.unreadHashes);
      await this.backfillSourceNames();

      const now = Date.now();
      await this.db.putSetting(Keys.lastAt, String(now));
      this.state.update((s) => ({ ...s, lastSyncedAt: now }));
      return { feeds, articles, pushed };
    } finally {
      this.syncing.set(false);
    }
  }

  /**
   * Local feeds the service has never heard of. Disabled feeds are excluded:
   * the two dead seeds (EWN, Reuters) are kept locally as a note to the user,
   * and subscribing someone's account to a feed we know is dead is not sync,
   * it is litter.
   */
  async pendingFeedPushes(): Promise<PendingFeedPush[]> {
    if (!this.linked) return [];
    return this.db.query<PendingFeedPush>(
      `SELECT id, url, sourceName FROM feeds
       WHERE remoteId IS NULL AND enabled = 1
       ORDER BY sortOrder, id`,
    );
  }

  /**
   * Subscribes the account to feeds the phone has and the service does not.
   * Each one is independent: a feed the service refuses does not stop the rest.
   */
  async pushFeeds(feeds: PendingFeedPush[]): Promise<{ added: number; failed: string[] }> {
    const bridge = this.bridgeFor(this.state().provider);
    if (!bridge) return { added: 0, failed: [] };

    let added = 0;
    const failed: string[] = [];

    for (const feed of feeds) {
      try {
        const remoteId = await bridge.addFeed(feed.url, feed.sourceName);
        if (remoteId) {
          await this.db.run('UPDATE feeds SET remoteId = ? WHERE id = ?', [remoteId, feed.id]);
        }
        // A null id is still a success: the service took the subscription and
        // the next pull adopts the feed by URL.
        added++;
      } catch {
        failed.push(feed.sourceName || feed.url);
      }
    }

    return { added, failed };
  }

  /**
   * Sends deletions the phone made while linked. The tombstone is dropped only
   * once the service has acknowledged, so a failed push is retried next time
   * rather than leaving the two lists disagreeing forever.
   */
  private async pushDeletions(bridge: SyncBridge): Promise<number> {
    const rows = await this.db.query<{ remoteId: string; url: string }>(
      'SELECT remoteId, url FROM deleted_feeds ORDER BY deletedAt LIMIT 100',
    );

    let removed = 0;
    for (const row of rows) {
      try {
        await bridge.removeFeed(row.remoteId, row.url);
        await this.db.run('DELETE FROM deleted_feeds WHERE remoteId = ?', [row.remoteId]);
        removed++;
      } catch {
        // Left in place; the next sync tries again.
      }
    }
    return removed;
  }

  /**
   * Marks locally-unread articles that the service no longer lists as unread.
   *
   * This is the whole of the read direction coming back. The story list only
   * ever contains unread stories, so a story read on the laptop is not in it —
   * its absence is the signal, and reconciling against the fetched stories
   * alone could never see it. Read state travelled one way until this ran.
   *
   * Rows with a push of their own still queued are left alone, so a read made
   * here is not undone by a snapshot taken before it was delivered.
   */
  private async applyRemoteReads(unreadHashes: string[]): Promise<void> {
    const unread = new Set(unreadHashes);

    const rows = await this.db.query<{ id: number; remoteHash: string }>(
      `SELECT id, remoteHash FROM articles
       WHERE remoteHash IS NOT NULL AND isRead = 0 AND readPushPending = 0`,
    );

    const readElsewhere = rows.filter((row) => !unread.has(row.remoteHash)).map((row) => row.id);
    if (!readElsewhere.length) return;

    // The service reports that a story is read, never when it was read, so
    // readAt records when we learned it. That is the honest value: it is what
    // the curator needs it for, and inventing the original moment would be
    // worse than being a sync cycle late.
    const now = Date.now();
    for (let i = 0; i < readElsewhere.length; i += 400) {
      const chunk = readElsewhere.slice(i, i + 400);
      await this.db.run(
        `UPDATE articles SET isRead = 1, readAt = COALESCE(readAt, ?)
         WHERE id IN (${chunk.map(() => '?').join(',')})`,
        [now, ...chunk],
      );
    }
  }

  /**
   * Repairs rows written before the publisher name was carried across. Cheap
   * and idempotent: it only touches articles that have a feed but no source,
   * so once everything is named it updates nothing.
   */
  private async backfillSourceNames(): Promise<void> {
    await this.db.run(
      `UPDATE articles
       SET sourceName = (SELECT f.sourceName FROM feeds f WHERE f.id = articles.feedId)
       WHERE (sourceName IS NULL OR sourceName = '')
         AND feedId IS NOT NULL`,
    );
  }

  /**
   * Reads made locally are queued rather than pushed immediately, so a poll on
   * a bad connection never loses them.
   */
  private async pushReadState(bridge: SyncBridge): Promise<number> {
    const rows = await this.db.query<{ remoteHash: string }>(
      `SELECT remoteHash FROM articles
       WHERE readPushPending = 1 AND remoteHash IS NOT NULL LIMIT 500`,
    );
    if (!rows.length) return 0;

    const hashes = rows.map((r) => r.remoteHash);
    const accepted = await bridge.pushRead(hashes);
    if (!accepted.length) return 0;

    const placeholders = accepted.map(() => '?').join(',');
    await this.db.run(
      `UPDATE articles SET readPushPending = 0 WHERE remoteHash IN (${placeholders})`,
      accepted,
    );
    return accepted.length;
  }

  private async applySnapshot(snapshot: SyncSnapshot): Promise<{ feeds: number; articles: number }> {
    const feedIdByRemote = new Map<string, number>();
    // Stories arrive knowing their feed id but not its name, and the publisher
    // is what the list and search show. Kept alongside the id mapping.
    const feedNameByRemote = new Map<string, string>();

    for (const feed of snapshot.feeds) {
      // Matched on URL as well as remoteId, so a feed already followed locally
      // is adopted rather than duplicated.
      const existing = await this.db.queryOne<{ id: number }>(
        'SELECT id FROM feeds WHERE remoteId = ? OR url = ? LIMIT 1',
        [feed.remoteId, feed.url],
      );

      if (existing) {
        await this.db.run('UPDATE feeds SET remoteId = ?, url = ? WHERE id = ?', [
          feed.remoteId,
          feed.url,
          existing.id,
        ]);
        feedIdByRemote.set(feed.remoteId, existing.id);
        feedNameByRemote.set(feed.remoteId, feed.title);
        continue;
      }

      const next = await this.db.queryOne<{ n: number }>(
        'SELECT COALESCE(MAX(sortOrder), -1) + 1 AS n FROM feeds',
      );
      const id = await this.db.insert(
        `INSERT INTO feeds (url, title, sourceName, enabled, sortOrder, consecutiveFailures, remoteId)
         VALUES (?, ?, ?, 1, ?, 0, ?)`,
        [feed.url, feed.title, feed.title, next?.n ?? 0, feed.remoteId],
      );
      feedIdByRemote.set(feed.remoteId, id);
      feedNameByRemote.set(feed.remoteId, feed.title);
    }

    const unread = new Set(snapshot.unreadHashes);
    let articles = 0;

    for (const story of snapshot.stories) {
      const feedId = feedIdByRemote.get(story.remoteFeedId) ?? null;
      const sourceName = feedNameByRemote.get(story.remoteFeedId) ?? null;
      const existing = await this.db.queryOne<{ id: number; isRead: number }>(
        'SELECT id, isRead FROM articles WHERE url = ?',
        [story.url],
      );

      if (existing) {
        // The service is authoritative for read state only where the local side
        // has nothing queued to say.
        //
        // readAt follows isRead exactly, including back to null: the service
        // can return a story to unread, and a row that is unread while still
        // carrying a read time is a trap for anything that later reads the
        // timestamp on its own.
        const remoteRead = !unread.has(story.hash);
        await this.db.run(
          `UPDATE articles SET remoteHash = ?,
             feedId = COALESCE(feedId, ?),
             sourceName = COALESCE(NULLIF(sourceName, ''), ?),
             isRead = CASE WHEN readPushPending = 1 THEN isRead ELSE ? END,
             readAt = CASE WHEN readPushPending = 1 THEN readAt
                           WHEN ? = 1 THEN COALESCE(readAt, ?)
                           ELSE NULL END
           WHERE id = ?`,
          [
            story.hash,
            feedId,
            sourceName,
            remoteRead ? 1 : 0,
            remoteRead ? 1 : 0,
            Date.now(),
            existing.id,
          ],
        );
        continue;
      }

      const now = Date.now();
      await this.db.run(
        `INSERT OR IGNORE INTO articles
           (feedId, url, title, author, publishedAt, sourceName, excerpt,
            extractionState, isSaved, isRead, isDismissed, scrollPosition,
            fetchedAt, remoteHash, readAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, 0, 0, ?, ?, ?)`,
        [
          feedId,
          story.url,
          story.title,
          story.author,
          story.publishedAt ?? now,
          sourceName,
          story.excerpt,
          unread.has(story.hash) ? 0 : 1,
          now,
          story.hash,
          unread.has(story.hash) ? null : now,
        ],
      );
      articles++;
    }

    return { feeds: snapshot.feeds.length, articles };
  }
}
