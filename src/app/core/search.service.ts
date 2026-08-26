import { Injectable, inject, signal } from '@angular/core';

import { Article, ExtractionState } from './models';
import { DbService, toBool } from './db.service';

/** One hit, with the passage that matched. */
export interface SearchHit {
  article: Article;
  /** Matching passage with <mark> around the terms, from FTS5 snippet(). */
  snippet: string;
  /** Where the match came from, so the UI can say "in the full text". */
  field: 'title' | 'excerpt' | 'body';
}

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

/** Indexing runs in slices so a large catch-up never blocks the UI. */
const INDEX_BATCH = 100;

@Injectable({ providedIn: 'root' })
export class SearchService {
  private readonly db = inject(DbService);

  /** Rows still waiting to be indexed, shown in settings. */
  readonly pending = signal(0);

  private indexing = false;

  get available(): boolean {
    return this.db.searchAvailable;
  }

  /**
   * Brings the index up to date with whatever the background poll wrote.
   *
   * The poll runs in Kotlin against a SQLite build that may not have FTS5, so
   * it cannot maintain the index itself and triggers are out. Instead every
   * article carries `indexedAt`, and this pass picks up whatever is missing.
   */
  async catchUp(): Promise<number> {
    if (!this.available || this.indexing) return 0;
    this.indexing = true;
    let indexed = 0;

    try {
      for (;;) {
        const rows = await this.db.query<{
          id: number;
          title: string;
          excerpt: string | null;
          bodyHtml: string | null;
        }>(
          `SELECT id, title, excerpt, bodyHtml FROM articles
           WHERE indexedAt IS NULL OR indexedAt < COALESCE(extractedAt, 0)
           ORDER BY id LIMIT ?`,
          [INDEX_BATCH],
        );
        if (!rows.length) break;

        for (const row of rows) {
          await this.indexOne(row.id, row.title, row.excerpt, row.bodyHtml);
          indexed++;
        }
      }

      await this.pruneDeleted();
      await this.refreshPending();
    } finally {
      this.indexing = false;
    }

    return indexed;
  }

  /**
   * Writes one article into the index. Called again after extraction, because
   * that is when a body first appears and the row becomes worth full-text
   * searching.
   */
  async indexOne(
    id: number,
    title: string,
    excerpt: string | null,
    bodyHtml: string | null,
  ): Promise<void> {
    if (!this.available) return;

    // rowid ties the entry to the article, so replacing means deleting first.
    await this.db.run(`DELETE FROM articles_fts WHERE rowid = ?`, [id]);
    await this.db.run(
      `INSERT INTO articles_fts (rowid, title, excerpt, body) VALUES (?, ?, ?, ?)`,
      [id, title ?? '', excerpt ?? '', plainText(bodyHtml)],
    );
    await this.db.run(`UPDATE articles SET indexedAt = ? WHERE id = ?`, [Date.now(), id]);
  }

  /** Drops entries whose article the native retention pass deleted. */
  private async pruneDeleted(): Promise<void> {
    await this.db.run(
      `DELETE FROM articles_fts WHERE rowid NOT IN (SELECT id FROM articles)`,
    );
  }

  async refreshPending(): Promise<void> {
    if (!this.available) {
      this.pending.set(0);
      return;
    }
    const row = await this.db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM articles
       WHERE indexedAt IS NULL OR indexedAt < COALESCE(extractedAt, 0)`,
    );
    this.pending.set(row?.n ?? 0);
  }

  /** How many articles are searchable, and how many of those have full text. */
  async stats(): Promise<{ indexed: number; withBody: number; archived: number }> {
    const row = await this.db.queryOne<{ indexed: number; withBody: number; archived: number }>(
      `SELECT COUNT(*) AS indexed,
              SUM(bodyHtml IS NOT NULL) AS withBody,
              SUM(isArchived) AS archived
       FROM articles WHERE indexedAt IS NOT NULL`,
    );
    return {
      indexed: row?.indexed ?? 0,
      withBody: row?.withBody ?? 0,
      archived: row?.archived ?? 0,
    };
  }

  /**
   * Ranked search across headlines, excerpts and the full text of anything
   * read. Archived articles are included on purpose — reaching things the
   * cache has already dropped is the whole point.
   *
   * The bm25 weights put a headline match well above a passing mention in
   * paragraph nine.
   */
  async search(rawQuery: string, limit = 60): Promise<SearchHit[]> {
    const match = toMatchExpression(rawQuery);
    if (!match || !this.available) return [];

    const rows = await this.db.query<ArticleRow & { snippet: string }>(
      `SELECT a.*,
              snippet(articles_fts, -1, '<mark>', '</mark>', '…', 18) AS snippet
       FROM articles_fts
       JOIN articles a ON a.id = articles_fts.rowid
       WHERE articles_fts MATCH ?
         AND a.isDismissed = 0
       ORDER BY bm25(articles_fts, 10.0, 4.0, 1.0)
       LIMIT ?`,
      [match, limit],
    );

    // Which field matched is worked out here rather than in SQL: FTS5 picks the
    // best column for the snippet but will not report which one it chose, and
    // the SQL needed to infer it was more fragile than this.
    const terms = searchTerms(rawQuery);

    return rows.map((row) => {
      const article = hydrate(row);
      return {
        article,
        snippet: row.snippet ?? '',
        field: containsAny(article.title, terms)
          ? ('title' as const)
          : containsAny(article.excerpt ?? '', terms)
            ? ('excerpt' as const)
            : ('body' as const),
      };
    });
  }
}

/**
 * Turns what someone typed into an FTS5 expression.
 *
 * Quoted runs stay phrases; everything else becomes a prefix term so results
 * appear while typing. FTS5 syntax characters are stripped rather than
 * escaped — a stray `*` or `:` pasted in should not blow up the query.
 */
export function toMatchExpression(raw: string): string | null {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length < 2) return null;

  const tokens: string[] = [];
  const phrase = /"([^"]+)"/g;
  let rest = trimmed;

  let found: RegExpExecArray | null;
  while ((found = phrase.exec(trimmed)) !== null) {
    const cleaned = sanitizeTerm(found[1]);
    if (cleaned) tokens.push(`"${cleaned}"`);
    rest = rest.replace(found[0], ' ');
  }

  for (const word of rest.split(/\s+/)) {
    // Stripping a syntax character can split one word into two, so each piece
    // becomes its own term rather than an accidental phrase.
    for (const piece of sanitizeTerm(word).split(' ')) {
      if (!piece) continue;
      // Quoted, then prefixed: quoting neutralises FTS5's own keywords (a
      // search for "near" must not be read as the NEAR operator), and the
      // trailing star is what makes "ramapho" find "Ramaphosa" as you type.
      tokens.push(`"${piece}"*`);
    }
  }

  return tokens.length ? tokens.join(' AND ') : null;
}

/**
 * OR of exact phrases, for topic keyword rules.
 *
 * Deliberately not the prefix matching that live search uses: "sport" as a
 * search term should find "sports", but a topic rule that quietly widened
 * itself would file the wrong articles for weeks before anyone noticed.
 */
export function toAnyPhraseExpression(terms: string[]): string | null {
  const phrases = terms
    .map((term) => sanitizeTerm(term))
    .filter(Boolean)
    .map((term) => `"${term}"`);
  return phrases.length ? phrases.join(' OR ') : null;
}

function sanitizeTerm(value: string): string {
  return value.replace(/["*():^{}[\]-]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Bare words from a query, for working out which field a hit came from. */
function searchTerms(raw: string): string[] {
  return (raw ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 1);
}

function containsAny(haystack: string, terms: string[]): boolean {
  const lower = haystack.toLowerCase();
  return terms.some((term) => lower.includes(term));
}

/** Strips tags so the index holds prose rather than markup. */
function plainText(html: string | null | undefined): string {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return (doc.body?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

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
