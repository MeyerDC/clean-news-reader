import { describe, expect, it } from 'vitest';

import { downloadMessage } from './home.page';

/**
 * The download promises the article will be there with no connection. Every
 * case where that promise is partial has to say so at the moment of download,
 * not in a tunnel later.
 */
describe('what a download reports', () => {
  it('confirms a complete download', () => {
    expect(downloadMessage({ state: 'ok', images: 'cached' }, 'Anything')).toBe('Saved for offline.');
  });

  it('says when the pictures were left behind', () => {
    // "Load images on mobile data" is off and we are on cellular. The text is
    // saved and that is a success — but claiming "saved for offline" would be
    // a promise the reader breaks later.
    expect(downloadMessage({ state: 'ok', images: 'deferred' }, 'Anything'))
      .toBe('Text saved. Images wait for Wi-Fi.');
  });

  it('does not blame the article when the network is the problem', () => {
    expect(downloadMessage({ state: 'offline' }, 'Anything'))
      .toBe('No connection — nothing to download from.');
  });

  it('names a paywall as a paywall', () => {
    const message = downloadMessage(
      { state: 'failed', reason: 'paywall', detail: 'x' },
      'Some headline',
    );
    expect(message).toBe('Some headline is paywalled.');
  });

  it('falls back for any other failure', () => {
    expect(downloadMessage({ state: 'failed', reason: 'other', detail: 'x' }, 'Anything'))
      .toBe('That article could not be downloaded.');
  });
});
