import { describe, expect, it } from 'vitest';

import {
  isDuplicateFeedError,
  isMissingFeedError,
  readAddedFeedId,
  readFeeds,
  readStories,
  readUnreadHashes,
  readableAddError,
  readableLoginError,
} from './newsblur.bridge';

/**
 * Shapes here are taken from real NewsBlur responses, not invented. The two
 * login cases in particular encode API behaviour that would otherwise be
 * discovered in production.
 */
describe('login verdict', () => {
  // Observed: a wrong username returns HTTP 200 with the failure in the body.
  it('reports the field-level error the API actually returns', () => {
    const body = {
      code: -1,
      errors: { username: ['Ensure this value has at most 30 characters (it has 31).'] },
      result: 'ok',
      authenticated: false,
    };
    expect(readableLoginError(body)).toContain('at most 30 characters');
  });

  it('falls back to a plain message when no field error is given', () => {
    expect(readableLoginError({ code: -1, authenticated: false })).toMatch(/username and password/i);
    expect(readableLoginError(null)).toMatch(/username and password/i);
  });
});

describe('readFeeds', () => {
  const body = {
    authenticated: true,
    user_id: 39040,
    feeds: {
      '170833': {
        id: 170833,
        feed_title: 'Thoughts of a Wierdo',
        feed_address: 'http://feeds.feedburner.com/atom.xml',
        feed_link: 'http://toaw.blogspot.com/',
        active: true,
      },
      '2': { id: 2, feed_title: 'Inactive', feed_address: 'https://x.example/feed', active: false },
      '3': { id: 3, feed_title: 'No address', active: true },
    },
  };

  it('maps the feed address, not the site link', () => {
    const feeds = readFeeds(body);
    // feed_link is the homepage; polling that would fetch HTML, not a feed.
    expect(feeds[0].url).toBe('http://feeds.feedburner.com/atom.xml');
    expect(feeds[0].remoteId).toBe('170833');
    expect(feeds[0].title).toBe('Thoughts of a Wierdo');
  });

  it('skips inactive feeds and ones with no address', () => {
    expect(readFeeds(body).map((f) => f.remoteId)).toEqual(['170833']);
  });

  it('survives an empty or malformed body', () => {
    expect(readFeeds(null)).toEqual([]);
    expect(readFeeds({})).toEqual([]);
  });
});

describe('readUnreadHashes', () => {
  it('flattens the per-feed map', () => {
    const body = { unread_feed_story_hashes: { '123': ['a:1', 'a:2'], '456': ['b:1'] } };
    expect(readUnreadHashes(body).sort()).toEqual(['a:1', 'a:2', 'b:1']);
  });

  it('handles the older [hash, timestamp] pair shape', () => {
    const body = { unread_feed_story_hashes: { '123': [['a:1', 1700000000], ['a:2', 1700000001]] } };
    expect(readUnreadHashes(body)).toEqual(['a:1', 'a:2']);
  });

  it('returns nothing when the field is absent', () => {
    expect(readUnreadHashes({})).toEqual([]);
    expect(readUnreadHashes(null)).toEqual([]);
  });
});

describe('readStories', () => {
  const body = {
    stories: [
      {
        story_hash: '170833:abc',
        story_feed_id: 170833,
        story_permalink: 'https://example.com/a?utm_source=newsblur',
        story_title: 'A story',
        story_authors: 'Jane Doe',
        story_timestamp: '1700000000',
        read_status: 0,
      },
      { story_hash: 'x:1', story_permalink: '', story_title: 'No link' },
      { story_permalink: 'https://example.com/b', story_title: 'No hash' },
    ],
  };

  it('normalises the permalink so it matches locally-stored articles', () => {
    // Identity is the normalised URL (spec section 6), so tracking parameters
    // must come off or the same story would be stored twice.
    expect(readStories(body)[0].url).toBe('https://example.com/a');
  });

  it('converts the timestamp from seconds to milliseconds', () => {
    expect(readStories(body)[0].publishedAt).toBe(1700000000000);
  });

  it('drops stories with no hash or no link', () => {
    expect(readStories(body)).toHaveLength(1);
  });

  it('reads read_status', () => {
    expect(readStories(body)[0].isRead).toBe(false);
    expect(readStories({ stories: [{ story_hash: 'h', story_permalink: 'https://e.com/x', read_status: 1 }] })[0].isRead).toBe(true);
  });
});

describe('story to article mapping', () => {
  // The publisher name is not on the story: NewsBlur puts it on the feed, and
  // the story only carries story_feed_id. Losing that link is what left search
  // results with a blank publisher.
  it('stories carry only a feed id, so the name must come from the feed list', () => {
    const stories = readStories({
      stories: [
        {
          story_hash: '170833:abc',
          story_feed_id: 170833,
          story_permalink: 'https://example.com/a',
          story_title: 'A story',
        },
      ],
    });
    expect(stories[0].remoteFeedId).toBe('170833');
    expect(stories[0]).not.toHaveProperty('sourceName');

    // …and the feed list is where that name lives.
    const feeds = readFeeds({
      authenticated: true,
      user_id: 1,
      feeds: {
        '170833': {
          id: 170833,
          feed_title: 'Thoughts of a Wierdo',
          feed_address: 'https://example.com/feed',
          active: true,
        },
      },
    });
    expect(feeds[0].remoteId).toBe(stories[0].remoteFeedId);
    expect(feeds[0].title).toBe('Thoughts of a Wierdo');
  });
});


/**
 * Pushing a feed writes to a real account, so what counts as failure matters
 * more than usual: treating "already subscribed" as an error would leave the
 * local feed unmarked and re-offer the same push forever.
 */
describe('adding a feed', () => {
  it('takes the id out of the feed object', () => {
    expect(readAddedFeedId({ result: 'ok', feed: { id: 170833, feed_title: 'GroundUp' } }))
      .toBe('170833');
  });

  it('accepts a top-level feed_id as well', () => {
    expect(readAddedFeedId({ result: 'ok', feed_id: 42 })).toBe('42');
  });

  it('returns null when the service names no feed', () => {
    // Not a failure: the subscription happened, and the next pull adopts it
    // by URL. Only the shortcut of knowing the id straight away is lost.
    expect(readAddedFeedId({ result: 'ok' })).toBeNull();
    expect(readAddedFeedId(null)).toBeNull();
  });

  it('treats an existing subscription as success, not failure', () => {
    expect(isDuplicateFeedError({ result: 'error', message: 'You are already subscribed to this feed.' }))
      .toBe(true);
  });

  it('treats a genuine refusal as failure', () => {
    expect(isDuplicateFeedError({ result: 'error', message: 'This address is not a feed.' }))
      .toBe(false);
  });

  it('surfaces the service\'s own words, with the feed that caused it', () => {
    const message = readableAddError(
      { result: 'error', message: 'This address is not a feed.' },
      'https://example.com/rss',
    );
    expect(message).toContain('https://example.com/rss');
    expect(message).toContain('not a feed');
  });

  it('reads errors given as a field map', () => {
    expect(readableAddError({ errors: { url: ['Enter a valid URL.'] } }, 'nonsense'))
      .toContain('Enter a valid URL');
  });
});

/**
 * A delete that finds nothing to delete has already achieved what it was for.
 * Failing it would keep the tombstone forever and retry it on every sync.
 */
describe('removing a feed', () => {
  it('treats a missing feed as already done', () => {
    expect(isMissingFeedError({ result: 'error', message: 'Feed not found' })).toBe(true);
  });

  it('does not swallow other errors', () => {
    expect(isMissingFeedError({ result: 'error', message: 'Not authenticated' })).toBe(false);
  });
});
