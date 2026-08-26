import { Injectable } from '@angular/core';
import { CapacitorHttp } from '@capacitor/core';

import { hostLabel, normalizeUrl, resolveUrl } from './url';

export interface DiscoveredFeed {
  url: string;
  /** The feed's own <title>, falling back to the site's hostname. */
  title: string;
  itemCount: number;
  /** Publication date of the newest entry, in ms. Null if it carries no dates. */
  newestItemAt: number | null;
  /**
   * Average gap between entries, in days. Separates a newsroom from an archive
   * far better than the newest date alone: a blog with one recent post looks
   * fresh on date and is not.
   */
  cadenceDays: number | null;
  /** How we found it, which the UI uses to explain itself. */
  via: 'declared' | 'probed';
}

/** Plain-language verdict on whether a feed is worth subscribing to. */
export type FeedHealth = 'live' | 'slow' | 'stalled' | 'archive' | 'undated';

const DAY = 86_400_000;

/**
 * Judged from a single fetch, so this is an estimate. Real liveness is observed
 * over time by the polling job, which records when a feed last produced
 * something new.
 */
export function feedHealth(feed: {
  newestItemAt: number | null;
  cadenceDays: number | null;
}): FeedHealth {
  if (feed.newestItemAt === null) return 'undated';
  // Publishers' clocks run ahead sometimes; a future date is not staleness.
  const ageDays = Math.max(0, (Date.now() - feed.newestItemAt) / DAY);

  if (ageDays > 90) return 'archive';
  if (ageDays > 14) return 'stalled';
  if ((feed.cadenceDays ?? 0) > 7) return 'slow';
  return 'live';
}

/**
 * Paths worth trying when a page does not declare its feed.
 *
 * Measured against fifteen publishers: this list found nine feeds that had no
 * <link rel="alternate"> tag at all, which turned out to be the majority case.
 * Ordered by how often each one hit.
 */
const PROBE_PATHS = [
  '/feed',
  '/rss',
  '/feed/',
  '/rss/',
  '/rss.xml',
  '/feed.xml',
  '/atom.xml',
  '/index.xml',
  '/news/feed',
  '/arc/outboundfeeds/rss/?outputType=xml',
];

const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0 Mobile Safari/537.36 CleanNews/1.0';

/** Never chase more than this many candidates; each one is a network round trip. */
const MAX_CANDIDATES = 6;


/**
 * Finds the feed behind a page.
 *
 * Roughly four in five publishers are reachable this way. The ones that are
 * not divide into sites with no feed at all, and sites that host their feed on
 * a different domain — which probing an article's own origin cannot reach.
 */
@Injectable({ providedIn: 'root' })
export class FeedDiscoveryService {
  /**
   * @param pageUrl any page on the site — usually an article someone shared
   * @param pageHtml the already-fetched HTML, when the caller has it. Passing
   *        it makes declared-feed discovery completely free, because the share
   *        flow has downloaded the page for extraction anyway.
   */
  async discover(pageUrl: string, pageHtml?: string): Promise<DiscoveredFeed[]> {
    const origin = originOf(pageUrl);
    if (!origin) return [];

    const html = pageHtml ?? (await this.fetchText(pageUrl));

    const candidates: { url: string; via: DiscoveredFeed['via'] }[] = [];
    const seen = new Set<string>();

    const add = (raw: string | null, via: DiscoveredFeed['via']) => {
      const url = normalizeUrl(raw);
      if (!url || seen.has(url)) return;
      seen.add(url);
      candidates.push({ url, via });
    };

    for (const declared of declaredFeeds(html, pageUrl)) add(declared, 'declared');
    for (const path of PROBE_PATHS) add(origin + path, 'probed');

    const found: DiscoveredFeed[] = [];
    let checked = 0;

    // Declared feeds first. A site that declares a fresh feed is telling the
    // truth and gets believed immediately — one request, same cost as before.
    for (const candidate of candidates.filter((c) => c.via === 'declared')) {
      if (checked >= MAX_CANDIDATES) break;
      checked++;
      const validated = await this.validate(candidate.url);
      if (!validated) continue;
      found.push({ ...validated, via: 'declared' });

      // Ranked even on the early return: a site can declare an archive before
      // its live feed, and every caller takes found[0].
      const health = feedHealth(validated);
      if (health === 'live' || health === 'slow') return rankByRecency(found);
    }

    // Nothing declared, or what was declared is stale. SAnews advertises only
    // an archive last updated in 2021 while its live feed sits unmentioned at
    // /rss.xml, so a stale declaration is a reason to keep looking, not to stop.
    for (const candidate of candidates.filter((c) => c.via === 'probed')) {
      if (checked >= MAX_CANDIDATES) break;
      checked++;
      const validated = await this.validate(candidate.url);
      if (validated) found.push({ ...validated, via: 'probed' });
    }

    return rankByRecency(found);
  }

  /** Confirms a URL really is a feed, and reads its title and size. */
  async validate(url: string): Promise<Omit<DiscoveredFeed, 'via'> | null> {
    const body = await this.fetchText(url);
    if (!body) return null;

    const head = body.slice(0, 1024).toLowerCase();
    if (!head.includes('<rss') && !head.includes('<feed') && !head.includes('<rdf:rdf')) {
      return null;
    }

    const doc = new DOMParser().parseFromString(body, 'text/xml');
    if (doc.querySelector('parsererror')) return null;

    const entries = doc.querySelectorAll('item, entry');
    if (!entries.length) return null;

    const dates = entryDates(doc);
    const newestItemAt = dates.length ? dates[0] : null;
    // Needs two dates to describe a gap; a single-item feed is judged on
    // recency alone.
    const cadenceDays =
      dates.length > 1 ? (dates[0] - dates[dates.length - 1]) / DAY / (dates.length - 1) : null;

    // The channel title, not an item's — take the first title outside an entry.
    const channelTitle =
      doc.querySelector('channel > title')?.textContent?.trim() ||
      doc.querySelector('feed > title')?.textContent?.trim() ||
      null;

    return {
      url,
      title: channelTitle || hostLabel(url),
      itemCount: entries.length,
      newestItemAt,
      cadenceDays,
    };
  }

  private async fetchText(url: string): Promise<string> {
    try {
      const response = await CapacitorHttp.get({
        url,
        headers: {
          'User-Agent': USER_AGENT,
          Accept:
            'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/html;q=0.8, */*;q=0.5',
        },
        responseType: 'text',
        connectTimeout: 10000,
        readTimeout: 12000,
      });
      if (response.status < 200 || response.status >= 300) return '';
      return typeof response.data === 'string' ? response.data : String(response.data ?? '');
    } catch {
      return '';
    }
  }
}

/** Reads <link rel="alternate" type="application/rss+xml"> out of a page. */
export function declaredFeeds(html: string, baseUrl: string): string[] {
  if (!html) return [];

  const doc = new DOMParser().parseFromString(html, 'text/html');
  const links = Array.from(
    doc.querySelectorAll<HTMLLinkElement>(
      'link[type="application/rss+xml"], link[type="application/atom+xml"]',
    ),
  );

  return links
    .map((link) => link.getAttribute('href'))
    .filter((href): href is string => !!href)
    .map((href) => resolveUrl(baseUrl, href))
    .filter((url): url is string => !!url)
    // Comment feeds are the classic false positive on WordPress sites.
    .filter((url) => !/\/comments\/feed|\?feed=comments/i.test(url));
}

/**
 * A one-line description of a candidate, for pickers and prompts.
 *
 * Item count alone is no help when choosing: SAnews offers two feeds with ten
 * entries each, one of them last updated in 2021. The signal the ranking used
 * is the signal the reader needs to see.
 */
export function describeFeed(feed: DiscoveredFeed): string {
  const health = feedHealth(feed);
  const items = `${feed.itemCount} item${feed.itemCount === 1 ? '' : 's'}`;

  if (health === 'undated') return `${items}, undated`;

  const ageDays = Math.max(0, Math.round((Date.now() - (feed.newestItemAt ?? 0)) / DAY));
  const when =
    ageDays === 0 ? 'updated today' : ageDays === 1 ? 'updated yesterday' : `${ageDays} days old`;

  switch (health) {
    case 'archive':
      return `Archive — newest ${when}`;
    case 'stalled':
      return `Stalled — newest ${when}`;
    case 'slow':
      return `${items}, ${when}`;
    default:
      return `${items}, ${when}`;
  }
}

/**
 * Newest first. Recency decides, because a feed's job is to carry current news
 * — GroundUp's Q&A section has more entries than its news feed, so item count
 * would hand you the wrong one.
 */
export function rankByRecency(feeds: DiscoveredFeed[]): DiscoveredFeed[] {
  const rank = (f: DiscoveredFeed) => {
    const order: Record<FeedHealth, number> = {
      live: 0, slow: 1, undated: 2, stalled: 3, archive: 4,
    };
    return order[feedHealth(f)];
  };

  return [...feeds].sort((a, b) => {
    const byHealth = rank(a) - rank(b);
    if (byHealth !== 0) return byHealth;
    // Within a band, the more recently updated feed wins; undated feeds fall
    // back to size, which is all that is left to go on.
    if (a.newestItemAt !== null && b.newestItemAt !== null) {
      return b.newestItemAt - a.newestItemAt;
    }
    return b.itemCount - a.itemCount;
  });
}

/** Entry publication dates, newest first. */
function entryDates(doc: Document): number[] {
  const out: number[] = [];
  doc.querySelectorAll('item, entry').forEach((entry) => {
    for (const tag of ['pubDate', 'published', 'updated', 'date']) {
      const raw = entry.getElementsByTagName(tag)[0]?.textContent?.trim();
      if (!raw) continue;
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) {
        out.push(parsed);
        break;
      }
    }
  });
  return out.sort((a, b) => b - a);
}

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}
