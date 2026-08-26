import { Injectable } from '@angular/core';
import { CapacitorHttp } from '@capacitor/core';

import { normalizeUrl } from '../url';
import { RemoteFeed, RemoteStory, SyncBridge, SyncIdentity, SyncSnapshot } from './sync.types';

const BASE = 'https://www.newsblur.com';

const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0 Mobile Safari/537.36 CleanNews/1.0';

/** NewsBlur caps usernames at 30 characters; catching it here beats a round trip. */
const MAX_USERNAME = 30;

/** How many story hashes to request or acknowledge in one call. */
const BATCH = 100;

/**
 * NewsBlur as a sync bridge.
 *
 * Two behaviours of this API are worth knowing, because both fail silently if
 * you assume the usual conventions:
 *
 *  1. `/api/login` answers **HTTP 200 for a wrong password**, with the real
 *     verdict in the body as `authenticated: false`. Checking the status code
 *     would treat a failed login as a success.
 *
 *  2. An unauthenticated `/reader/feeds` does not 401 — it returns a complete,
 *     valid-looking response containing the feeds of NewsBlur's public
 *     `homepage` demo account. "Got data" is not "logged in", and a bridge that
 *     assumed otherwise would import a stranger's 40 feeds into the user's list.
 *
 * So every response is checked for `authenticated`, and the account's own
 * `user_id` is verified against the one we linked.
 */
@Injectable({ providedIn: 'root' })
export class NewsBlurBridge implements SyncBridge {
  readonly provider = 'newsblur';

  /** Set once linked, so a session that silently becomes someone else is caught. */
  private expectedUserId: string | null = null;

  useAccount(userId: string | null): void {
    this.expectedUserId = userId;
  }

  async logIn(username: string, password: string): Promise<SyncIdentity> {
    const trimmed = (username ?? '').trim();
    if (!trimmed) throw new Error('Enter your NewsBlur username.');
    if (trimmed.length > MAX_USERNAME) {
      throw new Error(`NewsBlur usernames are at most ${MAX_USERNAME} characters.`);
    }

    const body = await this.form('/api/login', { username: trimmed, password: password ?? '' });

    // The status code says nothing here; the body is the verdict.
    if (body?.['authenticated'] !== true) {
      throw new Error(readableLoginError(body));
    }

    const identity = await this.whoAmI();
    if (!identity) throw new Error('NewsBlur accepted the login but returned no account.');
    this.expectedUserId = identity.userId;
    return identity;
  }

  async whoAmI(): Promise<SyncIdentity | null> {
    const body = await this.get('/reader/feeds', { include_favicons: 'false' });
    return this.identityOf(body);
  }

  async pull(): Promise<SyncSnapshot> {
    const feedsBody = await this.get('/reader/feeds', { include_favicons: 'false' });
    this.assertOurAccount(feedsBody);

    const feeds = readFeeds(feedsBody);

    const unreadBody = await this.get('/reader/unread_story_hashes', { include_timestamps: 'false' });
    this.assertOurAccount(unreadBody);
    const unreadHashes = readUnreadHashes(unreadBody);

    // Only the unread ones are worth fetching: read stories are already either
    // in the local database or deliberately gone.
    const stories = await this.storiesByHash(unreadHashes.slice(0, BATCH * 5));

    return { feeds, stories, unreadHashes };
  }

  async pushRead(hashes: string[]): Promise<string[]> {
    const accepted: string[] = [];
    for (let i = 0; i < hashes.length; i += BATCH) {
      const batch = hashes.slice(i, i + BATCH);
      const body = await this.form('/reader/mark_story_hashes_as_read', {}, batch.map((h) => ['story_hash', h]));
      // Only an explicit success counts. A null body — an unreachable service,
      // an HTML error page, anything unparseable — used to pass both guards
      // and clear readPushPending for reads that never arrived.
      if (wasAccepted(body)) accepted.push(...batch);
    }
    return accepted;
  }

  /**
   * NewsBlur discovers the feed itself, so a site address works as well as a
   * feed address. A duplicate is not an error worth surfacing: the account
   * ends up subscribed either way, which is all the caller asked for.
   */
  async addFeed(url: string, title?: string): Promise<string | null> {
    const fields: Record<string, string> = { url, auto_active: 'true' };
    // NewsBlur keeps its own title, but sending ours means a feed whose
    // <title> is "Home" does not arrive on the laptop called "Home".
    if (title) fields['feed_title'] = title;

    const body = await this.form('/reader/add_url', fields);
    if (body?.['authenticated'] === false) {
      throw new Error('Your NewsBlur session has expired. Sign in again.');
    }
    if (body?.['result'] === 'error' && !isDuplicateFeedError(body)) {
      throw new Error(readableAddError(body, url));
    }
    // Nothing came back that says the subscription was made. Reporting this as
    // added would tell someone their feeds are on their laptop when they are
    // not, so it fails and the offer returns at the next sync.
    if (!body) throw new Error(`NewsBlur did not answer when adding ${url}.`);
    return readAddedFeedId(body);
  }

  async removeFeed(remoteId: string, url: string): Promise<void> {
    // in_folder is required and may be empty: an absent value removes the feed
    // from the root folder only, which is not what a delete means here.
    const body = await this.form('/reader/delete_feed', {
      feed_id: remoteId,
      in_folder: '',
    });
    if (body?.['authenticated'] === false) {
      throw new Error('Your NewsBlur session has expired. Sign in again.');
    }
    // A feed already gone is the state we wanted; only a real failure throws.
    if (body?.['result'] === 'error' && !isMissingFeedError(body)) {
      throw new Error(readableAddError(body, url));
    }
  }

  async logOut(): Promise<void> {
    this.expectedUserId = null;
    await this.form('/api/logout', {}).catch(() => undefined);
  }

  // ---- internals --------------------------------------------------------

  private async storiesByHash(hashes: string[]): Promise<RemoteStory[]> {
    const stories: RemoteStory[] = [];
    for (let i = 0; i < hashes.length; i += BATCH) {
      const batch = hashes.slice(i, i + BATCH);
      const query = batch.map((h) => ['h', h] as [string, string]);
      const body = await this.get('/reader/river_stories', {}, query);
      stories.push(...readStories(body));
    }
    return stories;
  }

  private identityOf(body: Record<string, unknown> | null): SyncIdentity | null {
    if (!body || body['authenticated'] !== true) return null;
    const userId = body['user_id'];
    if (userId === undefined || userId === null) return null;

    const profile = body['social_profile'] as { username?: string } | undefined;
    return { userId: String(userId), username: profile?.username ?? String(userId) };
  }

  /**
   * Guards trap 2: a response can look perfect and belong to the demo account,
   * or to a different account if the session changed underneath us.
   */
  private assertOurAccount(body: Record<string, unknown> | null): void {
    const identity = this.identityOf(body);
    if (!identity) throw new Error('Your NewsBlur session has expired. Sign in again.');
    if (this.expectedUserId && identity.userId !== this.expectedUserId) {
      throw new Error('This NewsBlur session belongs to a different account.');
    }
  }

  private async get(
    path: string,
    params: Record<string, string> = {},
    repeated: [string, string][] = [],
  ): Promise<Record<string, unknown> | null> {
    const query = new URLSearchParams(params);
    for (const [k, v] of repeated) query.append(k, v);
    const url = `${BASE}${path}${query.toString() ? `?${query}` : ''}`;
    return this.request('GET', url);
  }

  private async form(
    path: string,
    fields: Record<string, string>,
    repeated: [string, string][] = [],
  ): Promise<Record<string, unknown> | null> {
    const body = new URLSearchParams(fields);
    for (const [k, v] of repeated) body.append(k, v);
    // NewsBlur takes form encoding, not JSON.
    return this.request('POST', `${BASE}${path}`, body.toString());
  }

  private async request(
    method: 'GET' | 'POST',
    url: string,
    data?: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const response = await CapacitorHttp.request({
        url,
        method,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
          ...(data === undefined
            ? {}
            : { 'Content-Type': 'application/x-www-form-urlencoded' }),
        },
        data,
        // The session lives in a cookie that CapacitorHttp keeps for us.
        responseType: 'json',
        connectTimeout: 15000,
        readTimeout: 20000,
      });
      if (typeof response.data === 'string') {
        try {
          return JSON.parse(response.data) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
      return (response.data ?? null) as Record<string, unknown> | null;
    } catch (error) {
      throw new Error(
        error instanceof Error ? `NewsBlur is unreachable: ${error.message}` : 'NewsBlur is unreachable.',
      );
    }
  }
}

/** The API reports field-level problems rather than a single message. */
export function readableLoginError(body: Record<string, unknown> | null): string {
  const errors = body?.['errors'] as Record<string, string[] | string> | undefined;
  if (errors) {
    for (const value of Object.values(errors)) {
      const first = Array.isArray(value) ? value[0] : value;
      if (first) return String(first);
    }
  }
  return 'NewsBlur did not accept that username and password.';
}

/**
 * An explicit success. NewsBlur answers `result: "ok"` on the endpoints that
 * report one; anything else — including a body we could not parse at all — is
 * treated as "we do not know", which for a queue means "try again".
 */
function wasAccepted(body: Record<string, unknown> | null): boolean {
  if (!body) return false;
  if (body['authenticated'] === false) return false;
  return body['result'] !== 'error';
}

/** The id of the feed /reader/add_url just subscribed us to, if it said. */
export function readAddedFeedId(body: Record<string, unknown> | null): string | null {
  const feed = body?.['feed'] as Record<string, unknown> | undefined;
  const id = feed?.['id'] ?? body?.['feed_id'];
  return id === undefined || id === null ? null : String(id);
}

/**
 * "You are already subscribed to this feed" is a success for our purposes —
 * the account ends up subscribed, which is the whole point of the call.
 */
export function isDuplicateFeedError(body: Record<string, unknown> | null): boolean {
  return /already subscribed|duplicate/i.test(errorText(body));
}

/** Likewise, deleting a feed that is not there has already had its effect. */
export function isMissingFeedError(body: Record<string, unknown> | null): boolean {
  return /not found|does not exist|no feed/i.test(errorText(body));
}

export function readableAddError(body: Record<string, unknown> | null, url: string): string {
  const text = errorText(body);
  return text ? `NewsBlur refused ${url}: ${text}` : `NewsBlur refused ${url}.`;
}

function errorText(body: Record<string, unknown> | null): string {
  const message = body?.['message'] ?? body?.['error'];
  if (typeof message === 'string' && message.trim()) return message.trim();

  const errors = body?.['errors'];
  if (typeof errors === 'string') return errors;
  if (errors && typeof errors === 'object') {
    for (const value of Object.values(errors as Record<string, unknown>)) {
      const first = Array.isArray(value) ? value[0] : value;
      if (typeof first === 'string' && first.trim()) return first.trim();
    }
  }
  return '';
}

export function readFeeds(body: Record<string, unknown> | null): RemoteFeed[] {
  const feeds = (body?.['feeds'] ?? {}) as Record<string, Record<string, unknown>>;
  const out: RemoteFeed[] = [];

  for (const [key, feed] of Object.entries(feeds)) {
    // feed_address is the RSS URL; feed_link is the site's homepage.
    const url = normalizeUrl(String(feed?.['feed_address'] ?? ''));
    if (!url) continue;
    // An unsubscribed or inactive feed is still listed; it is not ours to poll.
    if (feed['active'] === false) continue;

    out.push({
      remoteId: String(feed['id'] ?? key),
      url,
      title: String(feed['feed_title'] ?? '').trim() || url,
    });
  }
  return out;
}

export function readUnreadHashes(body: Record<string, unknown> | null): string[] {
  const raw = body?.['unread_feed_story_hashes'];
  if (!raw) return [];

  // Shaped as { feedId: [hash, ...] }, and older responses nest [hash, ts].
  const out: string[] = [];
  for (const value of Object.values(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === 'string') out.push(entry);
      else if (Array.isArray(entry) && typeof entry[0] === 'string') out.push(entry[0]);
    }
  }
  return out;
}

export function readStories(body: Record<string, unknown> | null): RemoteStory[] {
  const stories = (body?.['stories'] ?? []) as Record<string, unknown>[];
  const out: RemoteStory[] = [];

  for (const story of stories) {
    const url = normalizeUrl(String(story?.['story_permalink'] ?? ''));
    const hash = String(story?.['story_hash'] ?? '');
    if (!url || !hash) continue;

    const seconds = Number(story['story_timestamp']);
    out.push({
      hash,
      remoteFeedId: String(story['story_feed_id'] ?? ''),
      url,
      title: String(story['story_title'] ?? '').trim() || url,
      author: (String(story['story_authors'] ?? '').trim() || null),
      publishedAt: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
      excerpt: null,
      // read_status is 1 for read; absent means unread.
      isRead: Number(story['read_status'] ?? 0) === 1,
    });
  }
  return out;
}
