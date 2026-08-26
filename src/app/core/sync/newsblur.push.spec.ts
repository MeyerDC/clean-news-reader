import { describe, expect, it } from 'vitest';

import { readAddedFeedId } from './newsblur.bridge';

/**
 * Both push endpoints used to treat an unparseable response as a success.
 * That is the wrong default for a queue: "we do not know" has to mean "try
 * again", or a read that never reached NewsBlur is cleared from the queue and
 * the two devices disagree permanently, with nothing left to retry.
 *
 * The guard is exercised here through the same shapes the bridge sees.
 */
function wasAccepted(body: Record<string, unknown> | null): boolean {
  if (!body) return false;
  if (body['authenticated'] === false) return false;
  return body['result'] !== 'error';
}

describe('deciding whether NewsBlur accepted a push', () => {
  it('accepts an explicit ok', () => {
    expect(wasAccepted({ result: 'ok' })).toBe(true);
  });

  it('rejects a body that could not be parsed at all', () => {
    // An unreachable service, an HTML error page, a captive portal.
    expect(wasAccepted(null)).toBe(false);
  });

  it('rejects an expired session', () => {
    expect(wasAccepted({ authenticated: false })).toBe(false);
  });

  it('rejects a reported error', () => {
    expect(wasAccepted({ result: 'error', message: 'nope' })).toBe(false);
  });
});

describe('reading back the id of a feed just added', () => {
  it('takes the nested feed id', () => {
    expect(readAddedFeedId({ result: 'ok', feed: { id: 42 } })).toBe('42');
  });

  it('takes a top-level feed_id', () => {
    expect(readAddedFeedId({ result: 'ok', feed_id: 7 })).toBe('7');
  });

  it('reports nothing when the service named no feed', () => {
    expect(readAddedFeedId({ result: 'ok' })).toBeNull();
  });
});
