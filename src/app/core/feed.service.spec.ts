import { describe, expect, it } from 'vitest';

import { normalizeUrl } from './url';

/**
 * FeedService.update() decides whether an edit counts as a *URL change*, and
 * that decision has a consequence: a real change must clear lastEtag and
 * lastModified, because those validators describe the old address. Keep them
 * and the next poll asks "has this changed?" about a different resource, is
 * told 304, and concludes the new feed is unchanged — silently, forever.
 *
 * The comparison therefore has to be normalised on both sides. Seeded URLs were
 * stored verbatim, so a trailing slash must not read as an edit.
 */
describe('feed URL change detection', () => {
  const changed = (stored: string, typed: string) =>
    normalizeUrl(typed) !== normalizeUrl(stored);

  it('treats a trailing-slash difference as no change', () => {
    expect(changed('https://www.dailymaverick.co.za/dmrss/', 'https://www.dailymaverick.co.za/dmrss')).toBe(false);
  });

  it('treats a tracking parameter as no change', () => {
    expect(changed('https://example.com/feed', 'https://example.com/feed?utm_source=x')).toBe(false);
  });

  it('treats a different path as a change', () => {
    expect(changed('https://www.sanews.gov.za/rss-old.xml', 'https://www.sanews.gov.za/rss.xml')).toBe(true);
  });

  it('treats a different host as a change', () => {
    expect(changed('https://example.com/feed', 'https://other.example/feed')).toBe(true);
  });

  it('treats a scheme upgrade as a change', () => {
    expect(changed('http://example.com/feed', 'https://example.com/feed')).toBe(true);
  });
});

/**
 * articles.sourceName is a copy of the feed's name, taken when the article is
 * stored. That denormalisation is deliberate — articles outlive their feed, and
 * an archived article still needs a publisher — but it means a rename has to be
 * propagated, or one feed shows up as two publishers in the source filter.
 */
describe('renaming a feed', () => {
  // Reproduces the observed state: 49 articles on the old name, 1 on the new.
  const rows = [
    ...Array.from({ length: 49 }, () => ({ feedId: 1, sourceName: 'Daily Maverick' })),
    { feedId: 1, sourceName: 'Daily MaverickZA' },
    { feedId: null, sourceName: 'groundup.org.za' },
  ];

  const align = (feedId: number, feedName: string) =>
    rows.map((r) => (r.feedId === feedId ? { ...r, sourceName: feedName } : r));

  it('leaves one feed showing as two publishers until it is propagated', () => {
    const distinct = new Set(rows.filter((r) => r.feedId === 1).map((r) => r.sourceName));
    expect(distinct.size).toBe(2);
  });

  it('collapses to a single publisher once aligned', () => {
    const after = align(1, 'Daily MaverickZA');
    const distinct = new Set(after.filter((r) => r.feedId === 1).map((r) => r.sourceName));
    expect([...distinct]).toEqual(['Daily MaverickZA']);
  });

  it('does not touch articles shared in by hand', () => {
    const after = align(1, 'Daily MaverickZA');
    expect(after.find((r) => r.feedId === null)?.sourceName).toBe('groundup.org.za');
  });
});
