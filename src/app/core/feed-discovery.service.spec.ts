import { describe, expect, it } from 'vitest';

import { declaredFeeds } from './feed-discovery.service';

describe('declaredFeeds', () => {
  const base = 'https://example.com/news/story';

  it('finds an RSS autodiscovery link and resolves it', () => {
    const html = `<html><head>
      <link rel="alternate" type="application/rss+xml" href="/feed/">
    </head><body></body></html>`;
    expect(declaredFeeds(html, base)).toEqual(['https://example.com/feed/']);
  });

  it('finds Atom links too', () => {
    const html = `<link rel="alternate" type="application/atom+xml" href="https://example.com/atom.xml">`;
    expect(declaredFeeds(html, base)).toEqual(['https://example.com/atom.xml']);
  });

  it('ignores WordPress comment feeds, the classic false positive', () => {
    const html = `
      <link rel="alternate" type="application/rss+xml" href="/feed/">
      <link rel="alternate" type="application/rss+xml" href="/news/story/comments/feed/">`;
    expect(declaredFeeds(html, base)).toEqual(['https://example.com/feed/']);
  });

  it('returns nothing when the page declares no feed', () => {
    // The common case: nine of the twelve feeds found in testing had no tag.
    expect(declaredFeeds('<html><head><title>x</title></head></html>', base)).toEqual([]);
    expect(declaredFeeds('', base)).toEqual([]);
  });
});

import { DiscoveredFeed, describeFeed, feedHealth, rankByRecency } from './feed-discovery.service';

const DAY = 86_400_000;

function feed(
  title: string,
  daysOld: number | null,
  cadenceDays: number | null,
  itemCount = 10,
): DiscoveredFeed {
  return {
    url: `https://example.com/${title}`,
    title,
    itemCount,
    newestItemAt: daysOld === null ? null : Date.now() - daysOld * DAY,
    cadenceDays,
    via: 'probed',
  };
}

describe('feedHealth', () => {
  it.each([
    ['a newsroom', 0, 0.4, 'live'],
    ['a weekly', 3, 7.5, 'slow'],
    ['a stalled feed', 30, 2, 'stalled'],
    ['an archive', 566, 292, 'archive'],
    ['a feed with no dates', null, null, 'undated'],
  ])('calls %s "%s"', (_label, daysOld, cadence, expected) => {
    expect(feedHealth(feed('x', daysOld as number | null, cadence as number | null))).toBe(expected);
  });

  // A publisher's clock running ahead must not read as staleness.
  it('treats a future-dated item as fresh, not stale', () => {
    expect(feedHealth(feed('future', -1, 0.2))).toBe('live');
  });
});

describe('rankByRecency', () => {
  // The real numbers: SAnews declares only an archive last updated in 2021,
  // while its live feed sits unmentioned at /rss.xml.
  it('puts the live SAnews feed above the archive it advertises', () => {
    const ranked = rankByRecency([feed('rss-old.xml', 566, 292), feed('rss.xml', 0, 0.1)]);
    expect(ranked[0].title).toBe('rss.xml');
  });

  // GroundUp's Q&A section carries more entries than its news feed, so item
  // count picks the wrong one.
  it('prefers GroundUp news over the larger Q&A feed', () => {
    const ranked = rankByRecency([
      feed('qanda', 8, 3.2, 20),
      feed('sitenews', 0, 0.4, 15),
      feed('images-featured', 188, 22.6, 15),
    ]);
    expect(ranked.map((f) => f.title)).toEqual(['sitenews', 'qanda', 'images-featured']);
  });

  it('ranks an undated feed above a stalled one but below a live one', () => {
    const ranked = rankByRecency([feed('stalled', 40, 2), feed('undated', null, null), feed('live', 0, 0.2)]);
    expect(ranked.map((f) => f.title)).toEqual(['live', 'undated', 'stalled']);
  });

  it('falls back to size only when neither feed carries dates', () => {
    const ranked = rankByRecency([feed('small', null, null, 5), feed('big', null, null, 40)]);
    expect(ranked[0].title).toBe('big');
  });

  it('does not mutate the array it is given', () => {
    const input = [feed('a', 100, 5), feed('b', 0, 0.2)];
    const before = input.map((f) => f.title);
    rankByRecency(input);
    expect(input.map((f) => f.title)).toEqual(before);
  });
});

describe('describeFeed', () => {
  it('names an archive as such rather than quoting its size', () => {
    // The SAnews case: two feeds, ten entries each, five years apart.
    expect(describeFeed(feed('rss-old', 566, 292))).toMatch(/^Archive/);
    expect(describeFeed(feed('rss', 0, 0.1))).toBe('10 items, updated today');
  });

  it('flags a stalled feed', () => {
    expect(describeFeed(feed('quiet', 30, 2))).toMatch(/^Stalled/);
  });

  it('says so when a feed carries no dates', () => {
    expect(describeFeed(feed('nodates', null, null, 7))).toBe('7 items, undated');
  });

  it('handles the singular', () => {
    expect(describeFeed(feed('one', 0, null, 1))).toBe('1 item, updated today');
  });

  it('does not report a future-dated feed as negative days old', () => {
    expect(describeFeed(feed('ahead', -2, 0.2))).toBe('10 items, updated today');
  });
});
