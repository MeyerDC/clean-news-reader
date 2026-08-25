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
