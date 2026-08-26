import { describe, expect, it } from 'vitest';

import { ExtractionService } from './extraction.service';

/**
 * Publisher HTML is hostile input: it arrives from the open internet and is
 * rendered inside a webview that has a CORS-free HTTP client attached. These
 * tests are the regression guard on the two cleaning passes in cleanBody.
 */
const service = new ExtractionService();
const URL_BASE = 'https://publisher.example/news/story';

/** Everything that ends up in the DOM, for assertions. */
function clean(html: string): string {
  return service.cleanBody(html, URL_BASE).html;
}

describe('script injection', () => {
  it.each([
    ['inline script', '<p>ok</p><script>alert(1)</script>'],
    ['img error handler', '<img src="x" onerror="alert(1)">'],
    ['svg load handler', '<svg onload="alert(1)"></svg>'],
    ['body-ish handler', '<div onmouseover="alert(1)">hover</div>'],
    ['iframe', '<iframe src="https://evil.example/"></iframe>'],
    ['object', '<object data="evil.swf"></object>'],
    ['embed', '<embed src="evil.swf">'],
    ['form + formaction', '<form><button formaction="javascript:alert(1)">go</button></form>'],
    ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.example">'],
    ['base tag', '<base href="https://evil.example/">'],
    ['style block', '<style>@import url(https://evil.example/x.css);</style>'],
    ['link stylesheet', '<link rel="stylesheet" href="https://evil.example/x.css">'],
  ])('strips %s', (_label, payload) => {
    const out = clean(payload);
    expect(out).not.toMatch(/<script|<iframe|<object|<embed|<form|<style|<link|<meta|<base/i);
    expect(out).not.toMatch(/onerror|onload|onmouseover|formaction/i);
    expect(out).not.toMatch(/javascript:/i);
  });

  it('survives a mutation-XSS attempt without reintroducing a handler', () => {
    const out = clean(
      '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></p></noscript>',
    );
    expect(out).not.toMatch(/onerror/i);
  });
});

describe('dangerous URL schemes', () => {
  it('drops a javascript: href but keeps the text', () => {
    const out = clean('<a href="javascript:alert(1)">click me</a>');
    expect(out).not.toMatch(/javascript:/i);
    expect(out).toContain('click me');
  });

  it.each([
    ['data:', '<a href="data:text/html,<script>alert(1)</script>">x</a>'],
    ['vbscript:', '<a href="vbscript:msgbox(1)">x</a>'],
  ])('drops a %s href', (_label, payload) => {
    const out = clean(payload);
    expect(out).not.toMatch(/href="(data|vbscript):/i);
  });

  it('keeps an ordinary link and makes it absolute', () => {
    const out = clean('<a href="/other">more</a>');
    expect(out).toContain('https://publisher.example/other');
  });
});

describe('image sources', () => {
  it('drops a data: image', () => {
    const out = clean('<img src="data:image/svg+xml,<svg onload=alert(1)>">');
    expect(out).not.toMatch(/data:/i);
  });

  // An <img> cannot execute a local file, but the cache layer will happily try
  // to fetch whatever URL it is handed, so the scheme has to be constrained.
  it.each([
    ['file://', '<img src="file:///data/data/com.dmeyer.cleannews/databases/cleannewsSQLite.db">'],
    ['content://', '<img src="content://com.android.contacts/contacts">'],
  ])('does not carry a %s image through to the cache', (_label, payload) => {
    const result = service.cleanBody(payload, URL_BASE);
    expect(result.images.map((i) => i.url)).toEqual([]);
    expect(result.html).not.toMatch(/file:|content:/i);
  });
});

describe('image scheme allow-list', () => {
  it.each([
    ['http', 'http://cdn.example/a.jpg', true],
    ['https', 'https://cdn.example/a.jpg', true],
    ['protocol-relative', '//cdn.example/a.jpg', true],
    ['relative path', '/img/a.jpg', true],
    ['ftp', 'ftp://cdn.example/a.jpg', false],
    ['file', 'file:///etc/passwd', false],
    ['content', 'content://media/external/images/1', false],
    ['javascript', 'javascript:alert(1)', false],
  ])('%s image is %s', (_label, src, allowed) => {
    const result = service.cleanBody(`<img src="${src}"><p>body</p>`, URL_BASE);
    expect(result.images.length > 0).toBe(allowed);
    for (const image of result.images) {
      expect(image.url).toMatch(/^https?:\/\//i);
    }
  });
});
