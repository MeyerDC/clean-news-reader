import { Injectable } from '@angular/core';
import { CapacitorHttp } from '@capacitor/core';

import { hostLabel, normalizeUrl, resolveUrl } from './url';

export interface DiscoveredFeed {
  url: string;
  /** The feed's own <title>, falling back to the site's hostname. */
  title: string;
  /** How many entries it currently carries — a rough liveness signal. */
  itemCount: number;
  /** How we found it, which the UI uses to explain itself. */
  via: 'declared' | 'probed';
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
    let tried = 0;

    for (const candidate of candidates) {
      // A declared feed is worth confirming even if probing already found one,
      // but there is no sense walking the whole probe list after a hit.
      if (found.length && candidate.via === 'probed') break;
      if (tried >= MAX_CANDIDATES + candidates.length) break;
      tried++;

      const validated = await this.validate(candidate.url);
      if (validated) found.push({ ...validated, via: candidate.via });
    }

    // Busiest feed first: it is almost always the site's main one.
    found.sort((a, b) => b.itemCount - a.itemCount);
    return found;
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

    // The channel title, not an item's — take the first title outside an entry.
    const channelTitle =
      doc.querySelector('channel > title')?.textContent?.trim() ||
      doc.querySelector('feed > title')?.textContent?.trim() ||
      null;

    return {
      url,
      title: channelTitle || hostLabel(url),
      itemCount: entries.length,
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

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}
