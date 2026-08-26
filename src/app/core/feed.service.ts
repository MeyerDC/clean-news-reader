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
    // A synced feed leaves a tombstone. Without one the next pull re-adds it:
    // the service still has the subscription, and a feed that is absent locally
    // is indistinguishable from one not pulled yet.
    const feed = await this.db.queryOne<{ remoteId: string | null; url: string }>(
      'SELECT remoteId, url FROM feeds WHERE id = ?',
      [feedId],
    );
    if (feed?.remoteId) {
      await this.db.run(
        `INSERT OR REPLACE INTO deleted_feeds (remoteId, url, deletedAt) VALUES (?, ?, ?)`,
        [feed.remoteId, feed.url, Date.now()],
      );
    }

    await this.db.run('UPDATE articles SET feedId = NULL WHERE feedId = ?', [feedId]);
    await this.db.run('DELETE FROM feeds WHERE id = ?', [feedId]);
  }

  async setEnabled(feedId: number, enabled: boolean): Promise<void> {
    await this.db.run('UPDATE feeds SET enabled = ? WHERE id = ?', [fromBool(enabled), feedId]);
  }

  /**
   * Edits a feed in place. Replaces the old rename-only path, which never had
   * a caller, and covers the case that actually matters: correcting a URL.
   *
   * A site address is accepted as readily as a feed address — the caller runs
   * discovery first — so fixing a wrong feed does not mean knowing the right
   * one by heart.
   */
  async update(
    feedId: number,
    changes: { sourceName?: string; url?: string },
  ): Promise<void> {
    const current = await this.db.queryOne<FeedRow>('SELECT * FROM feeds WHERE id = ?', [feedId]);
    if (!current) throw new Error('That feed is no longer in your list.');

    const name = changes.sourceName?.trim();
    const url = changes.url === undefined ? undefined : normalizeUrl(changes.url);
    if (changes.url !== undefined && !url) {
      throw new Error('That does not look like a feed address.');
    }

    // Compared in normalised form. Seeded URLs were stored verbatim, so a
    // trailing slash would otherwise read as an edit and force a needless
    // re-fetch every time someone opened this dialog and pressed Save.
    const urlChanged = !!url && url !== normalizeUrl(current.url);
    if (urlChanged) {
      const clash = await this.db.queryOne<{ id: number }>(
        'SELECT id FROM feeds WHERE url = ? AND id <> ?',
        [url, feedId],
      );
      if (clash) throw new Error('You already follow that feed.');
    }

    if (urlChanged) {
      // The validators, the failure count and the error all describe the OLD
      // address. Carrying an ETag across means the next poll asks "has this
      // changed?" about a different resource, gets a 304, and concludes the
      // new feed is unchanged — a silent failure that never resolves itself.
      await this.db.run(
        `UPDATE feeds SET url = ?, sourceName = COALESCE(?, sourceName),
           lastEtag = NULL, lastModified = NULL, lastPolledAt = NULL,
           consecutiveFailures = 0, lastError = NULL,
           lastItemAt = NULL, lastNewArticleAt = NULL
         WHERE id = ?`,
        [url, name ?? null, feedId],
      );
      await this.alignArticleSourceNames(feedId);
      // Pick the new address up now rather than at the next scheduled poll.
      await CleanNews.pollNow().catch(() => undefined);
      return;
    }

    // Same feed, possibly a tidier spelling of its address: write both without
    // disturbing the validators.
    if (name || (url && url !== current.url)) {
      await this.db.run(
        'UPDATE feeds SET sourceName = COALESCE(?, sourceName), url = COALESCE(?, url) WHERE id = ?',
        [name ?? null, url ?? null, feedId],
      );
    }
    await this.alignArticleSourceNames(feedId);
  }

  /**
   * articles.sourceName is denormalised — copied from the feed when the article
   * is stored — so renaming a feed would otherwise leave every existing article
   * carrying the old name. The source filter is built from distinct article
   * names, so the feed would show up as two publishers, each holding half its
   * articles.
   *
   * Run unconditionally rather than only when the name changed, so it also
   * repairs drift left by earlier renames. Articles shared in by hand have no
   * feedId and keep the name extraction gave them.
   */
  private async alignArticleSourceNames(feedId: number): Promise<void> {
    await this.db.run(
      `UPDATE articles
       SET sourceName = (SELECT f.sourceName FROM feeds f WHERE f.id = ?)
       WHERE feedId = ?
         AND sourceName IS NOT (SELECT f.sourceName FROM feeds f WHERE f.id = ?)`,
      [feedId, feedId, feedId],
    );
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
