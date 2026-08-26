import { describe, expect, it } from 'vitest';

import { describeInterception } from './newsblur.bridge';

/**
 * A login request that never reaches NewsBlur used to be reported as a
 * rejected password, which is the worst possible misdiagnosis: it sends
 * someone off to retype a password that was right all along, on a network that
 * will refuse them every time.
 *
 * The pages below are what actually comes back — Cloudflare, a captive portal
 * and a filtering proxy all answer with HTML, not JSON.
 */
describe('naming what answered instead of NewsBlur', () => {
  it('pulls out a Cloudflare error code', () => {
    const page = `<!DOCTYPE html><html><head><title>Access denied | www.newsblur.com | Cloudflare</title>
      </head><body><h1>Error 1032</h1><p>Ray ID: 8f2a</p></body></html>`;
    const message = describeInterception(403, page);
    expect(message).toContain('error 1032');
    expect(message).toContain('Your password was never sent');
  });

  it('handles the lowercase "error code:" form', () => {
    expect(describeInterception(403, '<html><body>error code: 1020</body></html>'))
      .toContain('error 1020');
  });

  it('falls back to the page title when there is no code', () => {
    const page = '<html><head><title>Sign in to WiFi</title></head><body>Portal</body></html>';
    expect(describeInterception(200, page)).toContain('Sign in to WiFi');
  });

  it('still says something useful for an unrecognisable page', () => {
    const message = describeInterception(502, 'upstream connect failure');
    expect(message).toContain('HTTP 502');
    expect(message).toContain('answered instead of NewsBlur');
  });

  it('never suggests the credentials were wrong', () => {
    for (const body of ['<html><title>Blocked</title></html>', 'nonsense', '']) {
      expect(describeInterception(403, body)).not.toMatch(/password.*(wrong|incorrect|not accept)/i);
    }
  });
});
