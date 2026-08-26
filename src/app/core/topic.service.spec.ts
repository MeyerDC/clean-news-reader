import { describe, expect, it } from 'vitest';

import { Topic } from './models';
import { buildTopicClause } from './topic.service';
import { toAnyPhraseExpression } from './search.service';

const topic = (over: Partial<Topic>): Topic => ({
  id: 1,
  name: 'Sport',
  sortOrder: 0,
  feedIds: [],
  categories: [],
  keywords: [],
  ...over,
});

/**
 * A topic is three rules OR'd together, and each one exists because the others
 * cannot cover a particular feed: whole feeds for single-subject publishers,
 * categories for publishers that send them, keywords for the ones that send
 * nothing.
 */
describe('building a topic clause', () => {
  it('returns nothing for a topic with no rules', () => {
    // The caller must skip the query entirely — an empty clause list would
    // otherwise become "WHERE ()" or, worse, match every article.
    expect(buildTopicClause(topic({}))).toBeNull();
  });

  it('ORs the three kinds of rule rather than ANDing them', () => {
    const clause = buildTopicClause(
      topic({ feedIds: [4], categories: ['sport'], keywords: ['rugby'] }),
    );
    expect(clause!.sql).toContain(' OR ');
    expect(clause!.sql).not.toContain(' AND ');
  });

  it('matches a whole category and not a longer one that starts the same', () => {
    const clause = buildTopicClause(topic({ categories: ['Sport'] }));
    const pattern = clause!.params[0] as string;

    // Stands in for SQLite's LIKE: escape everything, then let % be the wildcard.
    const like = (stored: string) =>
      new RegExp(
        `^${pattern.replace(/[.*+?^${}()[\]\\|]/g, '\\$&').replace(/%/g, '.*')}$`,
      ).test(stored);

    expect(like('|sport|maverick news|')).toBe(true);
    expect(like('|sports betting|')).toBe(false);
  });

  it('lowercases categories, because that is how the poller stores them', () => {
    const clause = buildTopicClause(topic({ categories: ['Maverick News'] }));
    expect(clause!.params[0]).toBe('%|maverick news|%');
  });

  it('binds one placeholder per feed', () => {
    const clause = buildTopicClause(topic({ feedIds: [2, 5, 9] }));
    expect(clause!.sql).toContain('a.feedId IN (?,?,?)');
    expect(clause!.params).toEqual([2, 5, 9]);
  });

  it('drops a keyword rule that sanitises down to nothing', () => {
    // "***" is all FTS5 syntax. Passing it through would be a query error, and
    // an empty MATCH would match nothing while looking like a live rule.
    expect(buildTopicClause(topic({ keywords: ['***'] }))).toBeNull();
  });
});

/**
 * Search and topics want different matching. Typing "sport" into search should
 * find "sports" as you go; a saved topic rule that quietly widened itself would
 * misfile articles for weeks before anyone looked.
 */
describe('topic keyword expressions', () => {
  it('ORs the keywords', () => {
    expect(toAnyPhraseExpression(['rugby', 'Springbok'])).toBe('"rugby" OR "Springbok"');
  });

  it('does not prefix-match', () => {
    expect(toAnyPhraseExpression(['sport'])).not.toContain('*');
  });

  it('keeps a multi-word keyword as one phrase', () => {
    expect(toAnyPhraseExpression(['load shedding'])).toBe('"load shedding"');
  });

  it('strips FTS5 syntax rather than passing it through', () => {
    expect(toAnyPhraseExpression(['rug*by'])).toBe('"rug by"');
  });

  it('returns null when nothing usable is left', () => {
    expect(toAnyPhraseExpression([' ', '^'])).toBeNull();
  });
});
