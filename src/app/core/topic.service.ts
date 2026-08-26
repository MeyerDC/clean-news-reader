import { Injectable, inject, signal } from '@angular/core';

import { Topic } from './models';
import { DbService } from './db.service';
import { toAnyPhraseExpression } from './search.service';

interface TopicRow {
  id: number;
  name: string;
  sortOrder: number;
  feedIds: string | null;
  categories: string | null;
  keywords: string | null;
}

/** Pipe-wrapped so a whole value matches exactly: "|sport|" not "sports betting". */
const wrap = (values: (string | number)[]): string | null =>
  values.length ? `|${values.join('|')}|` : null;

const unwrap = (value: string | null): string[] =>
  (value ?? '').split('|').map((v) => v.trim()).filter(Boolean);

@Injectable({ providedIn: 'root' })
export class TopicService {
  private readonly db = inject(DbService);

  readonly revision = signal(0);

  async list(): Promise<Topic[]> {
    const rows = await this.db.query<TopicRow>('SELECT * FROM topics ORDER BY sortOrder, id');
    return rows.map(hydrate);
  }

  async get(id: number): Promise<Topic | null> {
    const row = await this.db.queryOne<TopicRow>('SELECT * FROM topics WHERE id = ?', [id]);
    return row ? hydrate(row) : null;
  }

  async save(topic: Omit<Topic, 'id' | 'sortOrder'> & { id?: number }): Promise<number> {
    const name = topic.name.trim();
    if (!name) throw new Error('Give the topic a name.');

    const values = [
      name,
      wrap(topic.feedIds),
      wrap(topic.categories.map((c) => c.toLowerCase())),
      topic.keywords.map((k) => k.trim()).filter(Boolean).join(',') || null,
    ];

    if (topic.id) {
      await this.db.run(
        'UPDATE topics SET name = ?, feedIds = ?, categories = ?, keywords = ? WHERE id = ?',
        [...values, topic.id],
      );
      this.revision.update((n) => n + 1);
      return topic.id;
    }

    const next = await this.db.queryOne<{ n: number }>(
      'SELECT COALESCE(MAX(sortOrder), -1) + 1 AS n FROM topics',
    );
    const id = await this.db.insert(
      'INSERT INTO topics (name, sortOrder, feedIds, categories, keywords) VALUES (?, ?, ?, ?, ?)',
      [values[0], next?.n ?? 0, values[1], values[2], values[3]],
    );
    this.revision.update((n) => n + 1);
    return id;
  }

  async remove(id: number): Promise<void> {
    await this.db.run('DELETE FROM topics WHERE id = ?', [id]);
    this.revision.update((n) => n + 1);
  }

  /**
   * Every category the feeds have actually published, so the editor offers a
   * pick-list rather than asking anyone to remember that Daily Maverick calls
   * its business section "business maverick".
   */
  async knownCategories(): Promise<{ name: string; articles: number }[]> {
    const rows = await this.db.query<{ categories: string }>(
      `SELECT categories FROM articles
       WHERE categories IS NOT NULL AND categories <> '' AND isDismissed = 0`,
    );

    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const category of unwrap(row.categories)) {
        counts.set(category, (counts.get(category) ?? 0) + 1);
      }
    }

    return [...counts.entries()]
      .map(([name, articles]) => ({ name, articles }))
      .sort((a, b) => b.articles - a.articles || a.name.localeCompare(b.name));
  }

  /** See buildTopicClause. */
  buildClause(topic: Topic): TopicClause | null {
    return buildTopicClause(topic);
  }

  /** Used by the editor's live preview, which is what makes rules tunable. */
  async countMatches(topic: Topic): Promise<number> {
    const clause = this.buildClause(topic);
    if (!clause) return 0;
    const row = await this.db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM articles a
       WHERE a.isDismissed = 0 AND a.isArchived = 0 AND ${clause.sql}`,
      clause.params,
    );
    return row?.n ?? 0;
  }

  async sampleMatches(topic: Topic, limit = 5): Promise<string[]> {
    const clause = this.buildClause(topic);
    if (!clause) return [];
    const rows = await this.db.query<{ title: string }>(
      `SELECT a.title FROM articles a
       WHERE a.isDismissed = 0 AND a.isArchived = 0 AND ${clause.sql}
       ORDER BY COALESCE(a.publishedAt, a.fetchedAt, 0) DESC LIMIT ?`,
      [...clause.params, limit],
    );
    return rows.map((r) => r.title);
  }
}

export interface TopicClause {
  sql: string;
  params: unknown[];
}

/**
 * The SQL a topic reduces to. Returned rather than executed so the list, the
 * count and the editor's live preview all run exactly the same rule.
 *
 * Clauses are OR'd: an article belongs to a topic if it came from one of its
 * feeds, or carries one of its categories, or matches one of its keywords.
 * AND would be wrong — a rugby piece in a general feed carries the category
 * but not the feed, and requiring both would file it nowhere.
 */
export function buildTopicClause(topic: Topic): TopicClause | null {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (topic.feedIds.length) {
    clauses.push(`a.feedId IN (${topic.feedIds.map(() => '?').join(',')})`);
    params.push(...topic.feedIds);
  }

  for (const category of topic.categories) {
    // The stored value is pipe-wrapped, so the pipes in the pattern are what
    // stop "sport" from matching a category called "sports betting".
    clauses.push('a.categories LIKE ?');
    params.push(`%|${category.toLowerCase()}|%`);
  }

  if (topic.keywords.length) {
    // Keywords go through the existing search index rather than a LIKE scan,
    // so a topic costs the same as a search: sub-millisecond at this size.
    const match = toAnyPhraseExpression(topic.keywords);
    if (match) {
      clauses.push('a.id IN (SELECT rowid FROM articles_fts WHERE articles_fts MATCH ?)');
      params.push(match);
    }
  }

  if (!clauses.length) return null;
  return { sql: `(${clauses.join(' OR ')})`, params };
}

function hydrate(row: TopicRow): Topic {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sortOrder,
    feedIds: unwrap(row.feedIds).map(Number).filter(Number.isFinite),
    categories: unwrap(row.categories),
    keywords: (row.keywords ?? '').split(',').map((k) => k.trim()).filter(Boolean),
  };
}
