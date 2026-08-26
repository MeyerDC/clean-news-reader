import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import {
  CapacitorSQLite,
  SQLiteConnection,
  SQLiteDBConnection,
} from '@capacitor-community/sqlite';

import { CleanNews } from './clean-news.plugin';

/**
 * Statements kept byte-for-byte in step with android/.../data/Schema.kt.
 *
 * Whichever side opens the database first creates the tables; both run the
 * same idempotent statements because the widget can be added — and therefore
 * the polling job can run — before the app is ever opened (spec 4.1).
 */
const TABLE_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS feeds (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     url TEXT NOT NULL UNIQUE,
     title TEXT,
     sourceName TEXT NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 1,
     sortOrder INTEGER NOT NULL DEFAULT 0,
     lastPolledAt INTEGER,
     lastEtag TEXT,
     lastModified TEXT,
     consecutiveFailures INTEGER NOT NULL DEFAULT 0,
     lastError TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS articles (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     feedId INTEGER,
     url TEXT NOT NULL UNIQUE,
     title TEXT NOT NULL,
     author TEXT,
     publishedAt INTEGER,
     sourceName TEXT,
     excerpt TEXT,
     leadImagePath TEXT,
     bodyHtml TEXT,
     extractionState TEXT NOT NULL DEFAULT 'pending',
     isSaved INTEGER NOT NULL DEFAULT 0,
     isRead INTEGER NOT NULL DEFAULT 0,
     isDismissed INTEGER NOT NULL DEFAULT 0,
     scrollPosition REAL NOT NULL DEFAULT 0,
     fetchedAt INTEGER,
     extractedAt INTEGER,
     isArchived INTEGER NOT NULL DEFAULT 0,
     archivedAt INTEGER,
     indexedAt INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS cached_images (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     articleId INTEGER NOT NULL,
     remoteUrl TEXT NOT NULL,
     localPath TEXT,
     width INTEGER,
     height INTEGER,
     caption TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  // A topic is a rule, not a tag. Three clauses, OR'd together, each matching
  // a different article-level signal — because no single signal covers every
  // feed: some publish categories, some are single-subject, some offer nothing
  // but their words.
  `CREATE TABLE IF NOT EXISTS topics (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     sortOrder INTEGER NOT NULL DEFAULT 0,
     /* Pipe-wrapped feed ids: "|3|7|" */
     feedIds TEXT,
     /* Pipe-wrapped lowercased categories: "|sport|soccer|" */
     categories TEXT,
     /* Comma-separated free text, matched against the search index. */
     keywords TEXT
   )`,
  // A feed deleted locally while a sync account is linked. Without this the
  // next pull re-adds it: the service still has it, and "absent locally" is
  // indistinguishable from "not yet pulled". The row is dropped once the
  // service has acknowledged the removal.
  `CREATE TABLE IF NOT EXISTS deleted_feeds (
     remoteId TEXT PRIMARY KEY,
     url TEXT NOT NULL,
     deletedAt INTEGER NOT NULL
   )`,
];

/**
 * Built only after ADDED_COLUMNS has run: an index may name a column that an
 * older database does not have yet, and on an existing file the CREATE TABLE
 * above is a no-op.
 */
const INDEX_SCHEMA: string[] = [
  `CREATE INDEX IF NOT EXISTS idx_articles_published ON articles (publishedAt DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_articles_feed ON articles (feedId)`,
  `CREATE INDEX IF NOT EXISTS idx_articles_list ON articles (isDismissed, isArchived, publishedAt DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_articles_indexed ON articles (indexedAt)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_images_article_url ON cached_images (articleId, remoteUrl)`,
];

/**
 * Columns added after the first release. A personal app is installed over the
 * top of its own data, so the schema has to be able to catch up. Mirrored in
 * android/.../data/Schema.kt (ADDED_COLUMNS).
 */
const ADDED_COLUMNS: [string, string][] = [
  ['isArchived', `ALTER TABLE articles ADD COLUMN isArchived INTEGER NOT NULL DEFAULT 0`],
  ['archivedAt', `ALTER TABLE articles ADD COLUMN archivedAt INTEGER`],
  ['indexedAt', `ALTER TABLE articles ADD COLUMN indexedAt INTEGER`],
  ['remoteHash', `ALTER TABLE articles ADD COLUMN remoteHash TEXT`],
  ['categories', `ALTER TABLE articles ADD COLUMN categories TEXT`],
  [
    'readPushPending',
    `ALTER TABLE articles ADD COLUMN readPushPending INTEGER NOT NULL DEFAULT 0`,
  ],
];

/** Columns added to `feeds`, mirrored in android/.../data/Schema.kt. */
const ADDED_FEED_COLUMNS: [string, string][] = [
  ['lastItemAt', `ALTER TABLE feeds ADD COLUMN lastItemAt INTEGER`],
  ['lastNewArticleAt', `ALTER TABLE feeds ADD COLUMN lastNewArticleAt INTEGER`],
  ['remoteId', `ALTER TABLE feeds ADD COLUMN remoteId TEXT`],
];

/**
 * The search index.
 *
 * Deliberately created only here, never by the Kotlin layer: this side runs
 * SQLCipher's bundled SQLite 3.53 which always has FTS5, while the native side
 * uses whatever SQLite the device shipped with. Keeping the virtual table on
 * one engine also rules out FTS triggers, which would fire during the
 * background poll — hence the catch-up indexing pass in SearchService.
 */
const SEARCH_SCHEMA: string[] = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
     title, excerpt, body,
     tokenize = 'porter unicode61 remove_diacritics 2'
   )`,
];

@Injectable({ providedIn: 'root' })
export class DbService {
  private connection = new SQLiteConnection(CapacitorSQLite);
  private db: SQLiteDBConnection | null = null;
  private opening: Promise<SQLiteDBConnection> | null = null;

  /** Relative directory (under Filesystem Directory.Data) holding cached images. */
  imageDir = 'article-images';

  /** False if this build's SQLite could not create the FTS5 table. */
  searchAvailable = false;

  /** Idempotent; every caller awaits the same open. */
  async ready(): Promise<SQLiteDBConnection> {
    if (this.db) return this.db;
    if (!this.opening) this.opening = this.open();
    try {
      this.db = await this.opening;
      return this.db;
    } finally {
      this.opening = null;
    }
  }

  private async open(): Promise<SQLiteDBConnection> {
    if (Capacitor.getPlatform() !== 'android') {
      throw new Error(
        'Koppie & Print stores articles in a database shared with the Android ' +
          'background job, so it only runs on a device.',
      );
    }

    // Ask the native side for the name rather than hard-coding it, so the two
    // layers cannot drift onto different files.
    const { name, imageDir } = await CleanNews.getDatabaseName();
    this.imageDir = imageDir;

    // A stale connection survives a webview reload, so reuse it if present.
    const isConsistent = (await this.connection.checkConnectionsConsistency()).result;
    const exists = (await this.connection.isConnection(name, false)).result;

    const db =
      isConsistent && exists
        ? await this.connection.retrieveConnection(name, false)
        : await this.connection.createConnection(name, false, 'no-encryption', 1, false);

    await db.open();
    for (const statement of TABLE_SCHEMA) {
      await db.execute(statement);
    }
    await this.addMissingColumns(db);
    for (const statement of INDEX_SCHEMA) {
      await db.execute(statement);
    }

    // Search is a nice-to-have: if the virtual table cannot be created the
    // rest of the app must still work, so this failure is recorded, not thrown.
    try {
      for (const statement of SEARCH_SCHEMA) {
        await db.execute(statement);
      }
      this.searchAvailable = true;
    } catch (error) {
      this.searchAvailable = false;
      console.warn('Full-text search unavailable:', error);
    }

    return db;
  }

  /** Brings an existing database up to the current column set. */
  private async addMissingColumns(db: SQLiteDBConnection): Promise<void> {
    await this.addColumns(db, 'articles', ADDED_COLUMNS);
    await this.addColumns(db, 'feeds', ADDED_FEED_COLUMNS);
  }

  private async addColumns(
    db: SQLiteDBConnection,
    table: string,
    columns: [string, string][],
  ): Promise<void> {
    const info = await db.query(`PRAGMA table_info(${table})`);
    const rows = (info.values ?? []) as { name: string }[];
    const existing = new Set(rows.map((row) => row.name));

    for (const [column, statement] of columns) {
      if (existing.has(column)) continue;
      try {
        await db.execute(statement);
      } catch (error) {
        console.warn(`Could not add ${table}.${column}:`, error);
      }
    }
  }

  /** SELECT returning typed rows. */
  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const db = await this.ready();
    const result = await db.query(sql, params as never[]);
    return (result.values ?? []) as T[];
  }

  async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows.length ? rows[0] : null;
  }

  /** INSERT/UPDATE/DELETE. Returns the number of rows changed. */
  async run(sql: string, params: unknown[] = []): Promise<number> {
    const db = await this.ready();
    const result = await db.run(sql, params as never[]);
    return result.changes?.changes ?? 0;
  }

  /** INSERT returning the new rowid. */
  async insert(sql: string, params: unknown[] = []): Promise<number> {
    const db = await this.ready();
    const result = await db.run(sql, params as never[]);
    return result.changes?.lastId ?? -1;
  }

  async getSetting(key: string): Promise<string | null> {
    const row = await this.queryOne<{ value: string }>(
      'SELECT value FROM settings WHERE key = ?',
      [key],
    );
    return row?.value ?? null;
  }

  async putSetting(key: string, value: string): Promise<void> {
    await this.run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, value],
    );
  }
}

/** SQLite has no boolean type; these keep the conversions in one place. */
export const toBool = (value: unknown): boolean => value === 1 || value === '1' || value === true;
export const fromBool = (value: boolean): number => (value ? 1 : 0);
