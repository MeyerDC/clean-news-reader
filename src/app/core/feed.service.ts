import { Injectable, inject } from '@angular/core';

import { Feed, FEED_FAILURE_THRESHOLD } from './models';
import { DbService, fromBool, toBool } from './db.service';
import { CleanNews } from './clean-news.plugin';
import { PollService } from './poll.service';
import { DiscoveredFeed } from './feed-discovery.service';
import { hostLabel, normalizeUrl } from './url';

type FeedRow = Omit<Feed, 'enabled'> & { enabled: number };

/** FR-11: the feed list is fully editable without a rebuild (criterion 8). */
@Injectable({ providedIn: 'root' })
export class FeedService {
  private readonly db = inject(DbService);
  private readonly polls = inject(PollService);

  async list(): Promise<Feed[]> {
    const rows = await this.db.query<FeedRow>(
      'SELECT * FROM feeds ORDER BY sortOrder ASC, id ASC',
    );
    return rows.map((row) => ({ ...row, enabled: toBool(row.enabled) }));
  }

  /** FR-11: per-feed status — a feed is flagged after five failed polls. */
  isFailing(feed: Feed): boolean {
    return feed.consecutiveFailures >= FEED_FAILURE_THRESHOLD;
  }

  /**
   * Hostnames already covered by a feed, so the share flow can tell whether a
   * site is new. "www." is stripped because a feed and its articles routinely
   * disagree about it.
   */
  async followedHosts(): Promise<Set<string>> {
    const feeds = await this.list();
    const hosts = new Set<string>();
    for (const feed of feeds) {
      const host = hostLabel(feed.url);
      if (host) hosts.add(host.toLowerCase());
    }
    return hosts;
  }

  /** True if any feed already covers the site this URL belongs to. */
  async isFollowing(articleUrl: string): Promise<boolean> {
    const host = hostLabel(articleUrl).toLowerCase();
    if (!host) return true; // Nothing sensible to offer; treat as covered.
    return (await this.followedHosts()).has(host);
  }

  /** Adds a feed that discovery turned up, using its own declared title. */
  async addDiscovered(feed: DiscoveredFeed): Promise<Feed> {
    return this.add(feed.url, feed.title);
  }

  async add(rawUrl: string, sourceName?: string): Promise<Feed> {
    const url = normalizeUrl(rawUrl);
    if (!url) throw new Error('That does not look like a feed address.');

    const existing = await this.db.queryOne<FeedRow>('SELECT * FROM feeds WHERE url = ?', [url]);
    if (existing) throw new Error('That feed is already in your list.');

    const next = await this.db.queryOne<{ n: number }>(
      'SELECT COALESCE(MAX(sortOrder), -1) + 1 AS n FROM feeds',
    );

    const name = sourceName?.trim() || hostLabel(url);
    const id = await this.db.insert(
      `INSERT INTO feeds (url, title, sourceName, enabled, sortOrder, consecutiveFailures)
       VALUES (?, ?, ?, 1, ?, 0)`,
      [url, name, name, next?.n ?? 0],
    );

    // Pick the new feed up now rather than at the next scheduled poll.
    await CleanNews.pollNow().catch(() => undefined);

    const created = await this.db.queryOne<FeedRow>('SELECT * FROM feeds WHERE id = ?', [id]);
    if (!created) throw new Error('Could not add that feed.');
    return { ...created, enabled: toBool(created.enabled) };
  }

  /**
   * Removing a feed leaves its articles behind — they are still worth reading,
   * and retention will clear them on the normal schedule.
   */
  async remove(feedId: number): Promise<void> {
    await this.db.run('UPDATE articles SET feedId = NULL WHERE feedId = ?', [feedId]);
    await this.db.run('DELETE FROM feeds WHERE id = ?', [feedId]);
  }

  async setEnabled(feedId: number, enabled: boolean): Promise<void> {
    await this.db.run('UPDATE feeds SET enabled = ? WHERE id = ?', [fromBool(enabled), feedId]);
  }

  async rename(feedId: number, sourceName: string): Promise<void> {
    const name = sourceName.trim();
    if (!name) return;
    await this.db.run('UPDATE feeds SET sourceName = ? WHERE id = ?', [name, feedId]);
  }

  /** FR-11: reorder. Positions are rewritten in one pass to stay dense. */
  async reorder(orderedIds: number[]): Promise<void> {
    for (let index = 0; index < orderedIds.length; index++) {
      await this.db.run('UPDATE feeds SET sortOrder = ? WHERE id = ?', [index, orderedIds[index]]);
    }
  }

  /** Clears a feed's error so the settings screen stops flagging it. */
  async clearError(feedId: number): Promise<void> {
    await this.db.run(
      'UPDATE feeds SET consecutiveFailures = 0, lastError = NULL WHERE id = ?',
      [feedId],
    );
  }

  /** Resolves once the background poll has actually finished. */
  async refreshNow(): Promise<void> {
    await this.polls.refreshNow();
  }
}
