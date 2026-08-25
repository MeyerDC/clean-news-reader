import { describe, expect, it } from 'vitest';

import { firstUrlIn, hostLabel, normalizeUrl } from './url';

/**
 * These rules decide article identity (spec section 6), and they are mirrored
 * in android/.../data/UrlNormalizer.kt. If a case here changes, change it there
 * too — otherwise the two layers disagree and the same story is stored twice.
 */
describe('normalizeUrl', () => {
  it('strips tracking parameters but keeps meaningful ones', () => {
    expect(
      normalizeUrl('https://example.com/story?utm_source=twitter&id=42&fbclid=abc'),
    ).toBe('https://example.com/story?id=42');
  });

  it('collapses the feed and share-sheet forms of one article onto one key', () => {
    const fromFeed = normalizeUrl('https://www.dailymaverick.co.za/article/2026-08-25-doula/');
    const fromShare = normalizeUrl(
      'https://www.dailymaverick.co.za/article/2026-08-25-doula/?utm_campaign=share#comments',
    );
    expect(fromShare).toBe(fromFeed);
  });

  it('drops the fragment', () => {
    expect(normalizeUrl('https://example.com/a#section')).toBe('https://example.com/a');
  });

  it('lowercases the host and removes a default port', () => {
    expect(normalizeUrl('https://EXAMPLE.com:443/A')).toBe('https://example.com/A');
    expect(normalizeUrl('http://example.com:80/a')).toBe('http://example.com/a');
  });

  it('preserves a non-default port', () => {
    expect(normalizeUrl('https://example.com:8443/a')).toBe('https://example.com:8443/a');
  });

  it('trims a trailing slash but keeps the root', () => {
    expect(normalizeUrl('https://example.com/a/')).toBe('https://example.com/a');
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('orders remaining parameters so argument order cannot fork identity', () => {
    expect(normalizeUrl('https://example.com/a?b=2&a=1')).toBe('https://example.com/a?a=1&b=2');
  });

  it('rejects anything that is not http(s)', () => {
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('ftp://example.com/a')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
    expect(normalizeUrl('')).toBeNull();
    expect(normalizeUrl(null)).toBeNull();
  });
});

describe('firstUrlIn', () => {
  it('pulls the link out of shared text (FR-8)', () => {
    expect(firstUrlIn('Worth a read https://example.com/story please')).toBe(
      'https://example.com/story',
    );
  });

  it('drops sentence punctuation that trails the link', () => {
    expect(firstUrlIn('Look at https://example.com/story.')).toBe('https://example.com/story');
  });

  it('normalises what it finds', () => {
    expect(firstUrlIn('see https://example.com/a?utm_source=x')).toBe('https://example.com/a');
  });

  it('returns null when the share contains no link', () => {
    expect(firstUrlIn('just some text')).toBeNull();
    expect(firstUrlIn('')).toBeNull();
  });
});

describe('hostLabel', () => {
  it('gives a readable placeholder source name', () => {
    expect(hostLabel('https://www.groundup.org.za/article/x')).toBe('groundup.org.za');
  });
});
