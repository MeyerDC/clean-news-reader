import { Injectable } from '@angular/core';
import { CapacitorHttp } from '@capacitor/core';
import { Readability } from '@mozilla/readability';
import DOMPurify from 'dompurify';

import { hostLabel, normalizeUrl, resolveUrl } from './url';

export interface ExtractedImage {
  url: string;
  caption: string | null;
}

export interface ExtractionSuccess {
  ok: true;
  /** The URL we ended on, which may differ from the one we started with. */
  finalUrl: string;
  title: string;
  author: string | null;
  publishedAt: number | null;
  sourceName: string;
  excerpt: string | null;
  bodyHtml: string;
  textLength: number;
  images: ExtractedImage[];
  leadImageUrl: string | null;
}

export interface ExtractionFailure {
  ok: false;
  /**
   * FR-7 distinguishes a paywall from a generic failure in the UI. 'video' is
   * the same idea: a page whose substance is a player, not prose, deserves to
   * say so rather than claim it could not be read.
   */
  reason: 'paywall' | 'other' | 'video';
  detail: string;
  finalUrl: string;
}

export type ExtractionResult = ExtractionSuccess | ExtractionFailure;

/** FR-4: below this many characters we do not consider it an article. */
const MIN_BODY_CHARS = 500;

/**
 * A page carrying a video embed needs more prose than this before we treat it
 * as an article that merely happens to have a video.
 *
 * Measured against real video posts: a standfirst plus a caption runs a few
 * hundred characters, while a genuine written piece with a video alongside it
 * ran nearly seven thousand. The character count alone gets this wrong — one
 * Daily Maverick video post cleared the 500 bar with 692 characters and
 * rendered as a stunted article with the video silently stripped out.
 */
const VIDEO_MIN_ARTICLE_CHARS = 1200;

/** Stands in for a player we will not embed. Rendered as a tappable block. */
const VIDEO_MARKER_HTML =
  '<p data-cn-video="">Video — watch on the original page</p>';

/** Embeds that mean "the story is the video". */
const VIDEO_EMBED_PATTERN =
  /(?:youtube(?:-nocookie)?\.com\/(?:embed|v)\/|youtu\.be\/|player\.vimeo\.com\/|dailymotion\.com\/embed\/|facebook\.com\/plugins\/video)/i;

/**
 * FR-4 paywall teaser detection. Kept deliberately specific — a false positive
 * here tells the user an article is paywalled when it is merely short.
 */
const PAYWALL_PATTERNS: RegExp[] = [
  /subscribe\s+to\s+(continue|keep)\s+reading/i,
  /this\s+article\s+is\s+(for|available\s+to)\s+subscribers/i,
  /subscribers?\s+only/i,
  /already\s+a\s+subscriber\?\s*sign\s*in/i,
  /register\s+to\s+(continue|keep)\s+reading/i,
  /sign\s+in\s+to\s+(continue|read)/i,
  /become\s+a\s+(member|subscriber)\s+to\s+read/i,
  /to\s+continue\s+reading\s+this\s+(article|story)/i,
  /you['’]ve\s+reached\s+your\s+(article|free)\s+limit/i,
  /unlock\s+this\s+(article|story)/i,
  /create\s+a\s+free\s+account\s+to\s+(read|continue)/i,
];

/**
 * Selectors for chrome Readability leaves behind. Readability already scores
 * most of this away; this pass catches publisher-specific blocks that survive.
 */
const JUNK_SELECTORS = [
  'script', 'style', 'noscript', 'iframe', 'object', 'embed', 'form',
  'button', 'input', 'select', 'textarea', 'svg use', 'link', 'meta',
  '[aria-hidden="true"]',
  '[role="dialog"]', '[role="alertdialog"]', '[role="banner"]',
  '[role="navigation"]', '[role="complementary"]', '[role="search"]',
  '[hidden]',
  // Ads and promos
  '[class*="advert" i]', '[id*="advert" i]', '[class*="-ad-" i]',
  '[class*="ad-slot" i]', '[class*="adsbygoogle" i]', 'ins.adsbygoogle',
  '[class*="sponsor" i]', '[data-ad]', '[data-ad-slot]',
  // Newsletter and subscription furniture
  '[class*="newsletter" i]', '[id*="newsletter" i]',
  '[class*="subscribe" i]', '[id*="subscribe" i]',
  '[class*="paywall" i]', '[class*="piano" i]', '[class*="meter" i]',
  // Related content rails
  '[class*="related" i]', '[id*="related" i]',
  '[class*="recommend" i]', '[class*="read-more" i]', '[class*="readmore" i]',
  '[class*="more-from" i]', '[class*="trending" i]', '[class*="most-read" i]',
  '[class*="outbrain" i]', '[class*="taboola" i]', '[class*="promo" i]',
  // Social and sharing
  '[class*="share" i]', '[id*="share" i]', '[class*="social" i]',
  'blockquote.twitter-tweet', '[class*="instagram-media" i]',
  '[class*="fb-post" i]', '[class*="tiktok-embed" i]',
  // Comments
  '[class*="comment" i]', '[id*="comment" i]', '[class*="disqus" i]',
  '#disqus_thread', '[class*="livefyre" i]',
  // Cookie / consent banners
  '[class*="cookie" i]', '[id*="cookie" i]', '[class*="consent" i]',
  '[id*="consent" i]', '[class*="gdpr" i]',
  // Navigation leftovers
  'nav', 'header', 'footer', 'aside',
];

/** Tags we keep in the rendered body (FR-4). Everything else is unwrapped. */
const ALLOWED_TAGS = new Set([
  'P', 'BR', 'HR',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'Q', 'CITE',
  'UL', 'OL', 'LI', 'DL', 'DT', 'DD',
  'A', 'EM', 'I', 'STRONG', 'B', 'U', 'S', 'SUP', 'SUB', 'SMALL', 'MARK',
  'FIGURE', 'FIGCAPTION', 'IMG', 'PICTURE',
  'PRE', 'CODE', 'SPAN', 'DIV', 'SECTION', 'ARTICLE',
  'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'CAPTION',
  'TIME',
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  A: new Set(['href', 'title']),
  IMG: new Set(['src', 'alt', 'width', 'height']),
  TIME: new Set(['datetime']),
  TD: new Set(['colspan', 'rowspan']),
  TH: new Set(['colspan', 'rowspan', 'scope']),
};

const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0 Mobile Safari/537.36 CleanNews/1.0';

/**
 * FR-4: turn a URL into clean article content.
 *
 * The fetch goes through CapacitorHttp rather than the webview's fetch, because
 * publisher origins do not send CORS headers and the webview would be blocked
 * (spec section 4).
 */
@Injectable({ providedIn: 'root' })
export class ExtractionService {
  async extract(url: string): Promise<ExtractionResult> {
    let response;
    try {
      response = await CapacitorHttp.get({
        url,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-ZA,en;q=0.9',
        },
        responseType: 'text',
        connectTimeout: 15000,
        readTimeout: 20000,
      });
    } catch (error) {
      return {
        ok: false,
        reason: 'other',
        detail: error instanceof Error ? error.message : 'Network request failed',
        finalUrl: url,
      };
    }

    // Redirects are followed natively; the URL we ended on is the article's
    // real identity (spec section 6).
    const finalUrl = normalizeUrl(response.url) ?? url;

    if (response.status < 200 || response.status >= 300) {
      return {
        ok: false,
        reason: response.status === 402 ? 'paywall' : 'other',
        detail: `The site returned HTTP ${response.status}.`,
        finalUrl,
      };
    }

    const html = typeof response.data === 'string' ? response.data : String(response.data ?? '');
    if (!html.trim()) {
      return { ok: false, reason: 'other', detail: 'The page was empty.', finalUrl };
    }

    return this.extractFromHtml(html, finalUrl);
  }

  /**
   * Split out from the fetch so a body that arrived with the feed
   * (content:encoded, FR-1) goes through exactly the same cleaning.
   */
  extractFromHtml(html: string, url: string): ExtractionResult {
    const doc = this.parse(html, url);

    // A paywall teaser is often the whole page, so check the raw document too:
    // Readability can otherwise return a plausible-looking 200-word stub.
    const rawPaywallHit = this.paywallHit(doc.body?.textContent ?? '');

    // Detected here, on the untouched document, because the sanitiser strips
    // iframes long before the verdict is reached — by then the only evidence
    // that this was a video is gone.
    const hasVideo = this.hasVideoEmbed(doc);

    let article: ReturnType<Readability['parse']>;
    try {
      // Readability mutates the document it is given, hence the fresh parse.
      article = new Readability(doc, { charThreshold: 250 }).parse();
    } catch (error) {
      return {
        ok: false,
        reason: 'other',
        detail: error instanceof Error ? error.message : 'Readability failed',
        finalUrl: url,
      };
    }

    if (!article || !article.content) {
      return {
        ok: false,
        reason: rawPaywallHit ? 'paywall' : hasVideo ? 'video' : 'other',
        detail: hasVideo
          ? 'There is no article here — the story is the video.'
          : 'There was no article body to read on this page.',
        finalUrl: url,
      };
    }

    const cleaned = this.cleanBody(article.content, url);
    const text = cleaned.text;

    if (this.paywallHit(text) || (rawPaywallHit && text.length < MIN_BODY_CHARS * 2)) {
      return {
        ok: false,
        reason: 'paywall',
        detail: 'This article looks like it is behind a paywall.',
        finalUrl: url,
      };
    }

    // Judged before the plain length check: a video post with a caption is not
    // a failed article, and saying so is more use than "couldn't read this".
    if (hasVideo && text.length < VIDEO_MIN_ARTICLE_CHARS) {
      return {
        ok: false,
        reason: 'video',
        detail: 'There is no article here — the story is the video.',
        finalUrl: url,
      };
    }

    if (text.length < MIN_BODY_CHARS) {
      return {
        ok: false,
        reason: 'other',
        detail: 'There was not enough article text on this page to read.',
        finalUrl: url,
      };
    }

    const metadata = this.readMetadata(this.parse(html, url));

    // Readability drops the player: on these pages it sits outside the article
    // node entirely, so markVideoEmbeds never sees it. Adding the marker after
    // cleaning keeps the fact visible even though the position is lost, and
    // avoids it being mistaken for a leading byline on the way through.
    const bodyHtml =
      hasVideo && !cleaned.html.includes('data-cn-video')
        ? `${VIDEO_MARKER_HTML}${cleaned.html}`
        : cleaned.html;

    return {
      ok: true,
      finalUrl: url,
      title: (article.title || metadata.title || hostLabel(url)).trim(),
      author: article.byline?.trim() || metadata.author,
      publishedAt: metadata.publishedAt,
      sourceName: article.siteName?.trim() || metadata.siteName || hostLabel(url),
      excerpt: article.excerpt?.trim() || text.slice(0, 300),
      bodyHtml,
      textLength: text.length,
      images: cleaned.images,
      leadImageUrl: metadata.leadImage ?? cleaned.images[0]?.url ?? null,
    };
  }

  private parse(html: string, baseUrl: string): Document {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // Readability resolves relative URLs off <base>, and many pages omit it.
    if (!doc.querySelector('base')) {
      const base = doc.createElement('base');
      base.setAttribute('href', baseUrl);
      doc.head?.appendChild(base);
    }
    return doc;
  }

  /**
   * True when the page carries a real video player. og:type is no help here —
   * every video post tested still declared itself an "article".
   */
  hasVideoEmbed(doc: Document): boolean {
    const framed = Array.from(doc.querySelectorAll('iframe[src], embed[src]')).some((node) =>
      VIDEO_EMBED_PATTERN.test(node.getAttribute('src') ?? ''),
    );
    if (framed) return true;

    if (doc.querySelector('video source[src], video[src]')) return true;

    return !!doc.querySelector('meta[property="og:video"], meta[property="og:video:url"]');
  }

  private paywallHit(text: string): boolean {
    const sample = text.replace(/\s+/g, ' ').slice(0, 4000);
    return PAYWALL_PATTERNS.some((pattern) => pattern.test(sample));
  }

  /**
   * FR-4/FR-5: strips the remaining chrome, keeps figure captions, rewrites
   * image sources to absolute URLs and reports the images to cache.
   *
   * Public because the reader runs stored bodies through it again before
   * display. That covers bodies which never went through extract() at all —
   * FR-1 stores <content:encoded> straight from the feed — so exactly one
   * sanitising path stands between a publisher's markup and the webview.
   */
  cleanBody(
    contentHtml: string,
    baseUrl: string,
    /** When known, lets a leading block that is just the author be removed. */
    author?: string | null,
  ): { html: string; text: string; images: ExtractedImage[] } {
    // The embed is turned into a marker before the sanitiser removes it, so a
    // genuine article that also carries a video keeps a visible trace of it in
    // the right place rather than losing it silently.
    const marked = markVideoEmbeds(contentHtml);

    // Two passes, in this order and for different reasons. DOMPurify is the
    // security boundary: it removes scripts, event handlers and dangerous URL
    // schemes far more reliably than hand-rolled rules. The allow-list below
    // is the editorial boundary: it decides what belongs in a reading view.
    const safeHtml = DOMPurify.sanitize(marked, {
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'link'],
      FORBID_ATTR: ['style', 'srcset'],
      // Keep the lazy-loading attributes; collectImages needs them to find the
      // real image URL, and the allow-list pass strips them afterwards.
      ADD_ATTR: ['data-src', 'data-lazy-src', 'data-original', 'data-srcset', 'data-cn-video'],
    });

    const doc = new DOMParser().parseFromString(
      `<div id="cn-root">${safeHtml}</div>`,
      'text/html',
    );
    const root = doc.getElementById('cn-root');
    if (!root) return { html: '', text: '', images: [] };

    for (const selector of JUNK_SELECTORS) {
      let matches: NodeListOf<Element>;
      try {
        matches = root.querySelectorAll(selector);
      } catch {
        continue; // A selector no engine understands is not worth failing over.
      }
      matches.forEach((element) => {
        // A figure whose class happens to say "share" still holds the picture,
        // so never drop a node that contains the only images we have.
        if (element.querySelector('img') && element.textContent!.trim().length < 200) return;
        element.remove();
      });
    }

    const images = this.collectImages(root, baseUrl);
    this.sanitize(root, baseUrl);
    this.dropEmptyNodes(root);
    this.dropLeadingByline(root, author);

    return {
      html: root.innerHTML.trim(),
      text: (root.textContent ?? '').replace(/\s+/g, ' ').trim(),
      images,
    };
  }

  /** Resolves image sources and pairs each with its caption where present. */
  private collectImages(root: Element, baseUrl: string): ExtractedImage[] {
    const images: ExtractedImage[] = [];
    const seen = new Set<string>();

    root.querySelectorAll('img').forEach((img) => {
      // Lazy-loading publishers park the real URL in a data attribute and
      // leave src as a placeholder pixel.
      const candidate =
        firstFromSrcset(img.getAttribute('srcset')) ??
        img.getAttribute('data-src') ??
        img.getAttribute('data-lazy-src') ??
        img.getAttribute('data-original') ??
        firstFromSrcset(img.getAttribute('data-srcset')) ??
        img.getAttribute('src');

      const absolute = candidate ? resolveUrl(baseUrl, candidate.trim()) : null;
      if (!absolute || absolute.startsWith('data:')) {
        img.remove();
        return;
      }

      // Masthead and accreditation badges: a picture whose only job is to link
      // back to the site's front page is furniture, not part of the story.
      if (isPublisherFurniture(img, baseUrl)) {
        (img.closest('figure') ?? img).remove();
        return;
      }

      img.setAttribute('src', absolute);
      img.removeAttribute('srcset');
      img.removeAttribute('loading');

      // FR-5: preserve figure captions.
      const figure = img.closest('figure');
      const caption =
        figure?.querySelector('figcaption')?.textContent?.trim() ||
        img.getAttribute('alt')?.trim() ||
        null;

      if (caption) img.setAttribute('data-caption', caption);

      if (!seen.has(absolute)) {
        seen.add(absolute);
        images.push({ url: absolute, caption: caption || null });
      }
    });

    return images;
  }

  /** Allow-list pass: unknown elements are unwrapped, not deleted. */
  private sanitize(root: Element, baseUrl: string): void {
    const walk = (node: Element): void => {
      // Snapshot the children: the loop reparents nodes as it unwraps.
      const children = Array.from(node.children);
      for (const child of children) walk(child);

      if (node === root) return;

      if (!ALLOWED_TAGS.has(node.tagName)) {
        // Keep the text; drop the element.
        const parent = node.parentNode;
        if (parent) {
          while (node.firstChild) parent.insertBefore(node.firstChild, node);
          parent.removeChild(node);
        }
        return;
      }

      const allowed = ALLOWED_ATTRS[node.tagName] ?? new Set<string>();
      for (const attr of Array.from(node.attributes)) {
        const name = attr.name.toLowerCase();
        if (name === 'data-caption' || name === 'data-cn-video') continue;
        if (!allowed.has(name)) node.removeAttribute(attr.name);
      }

      if (node.tagName === 'A') {
        const href = node.getAttribute('href');
        const absolute = href ? resolveUrl(baseUrl, href) : null;
        // javascript: and other schemes resolve to something we will not open.
        if (!absolute || !/^https?:/i.test(absolute)) {
          node.removeAttribute('href');
        } else {
          node.setAttribute('href', absolute);
        }
      }
    };

    walk(root);
  }

  /**
   * Publishers often repeat the byline and timestamp as the first line of the
   * article body. The reader already shows both above the text, so a duplicate
   * there is exactly the chrome this app exists to remove.
   *
   * Only short leading blocks that look like a byline are touched, and the scan
   * stops at the first real paragraph so nothing in the article itself is lost.
   */
  private dropLeadingByline(root: Element, author?: string | null): void {
    const bylinePatterns = [
      /^by\s+\S/i,
      /\bpublished\b/i,
      /\blast\s+updated\b/i,
      /^\d+\s+(minutes?|hours?|days?)\s+ago$/i,
      /^(share|save)$/i,
      // Audio-player furniture: the "listen to this article" strip and the
      // bare media timestamp that sits next to it.
      /listen to this article/i,
      /^\d{1,2}:\d{2}$/,
      // A block that is only a date — "20 Aug", "25 August 2026".
      /^\d{1,2}\s+[a-z]{3,9}(\s+\d{4})?$/i,
      /^[a-z]{3,9}\s+\d{1,2},?(\s+\d{4})?$/i,
    ];

    // Bounded: a date, a byline, a share strip and an audio player is as much
    // furniture as any publisher stacks above the first paragraph. The length
    // check below is what actually stops it — the first real block ends the
    // scan whether or not the budget is spent.
    for (let i = 0; i < 5; i++) {
      const block = leadingTextBlock(root);
      if (!block) return;

      const text = block.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      // A real opening paragraph is longer than any byline.
      if (!text || text.length > 120) return;

      // A leading block that is exactly the author we already show in the
      // byline is safe to drop by name, where a bare name in general is not.
      const isAuthorLine =
        !!author && text.replace(/^by\s+/i, '').toLowerCase() === author.trim().toLowerCase();

      if (!isAuthorLine && !bylinePatterns.some((pattern) => pattern.test(text))) return;

      block.remove();
    }
  }

  /** Removes wrappers left hollow by the passes above. */
  private dropEmptyNodes(root: Element): void {
    const containers = Array.from(root.querySelectorAll('div, section, span, p, li'));
    // Reverse order so a parent is judged after its children were removed.
    for (const element of containers.reverse()) {
      const hasContent = element.textContent?.trim().length;
      const hasMedia = element.querySelector('img, br, hr');
      if (!hasContent && !hasMedia) element.remove();
    }
  }

  /** Publication date, lead image and site name from the page's metadata. */
  private readMetadata(doc: Document): {
    title: string | null;
    author: string | null;
    siteName: string | null;
    publishedAt: number | null;
    leadImage: string | null;
  } {
    const meta = (selector: string): string | null =>
      doc.querySelector(selector)?.getAttribute('content')?.trim() || null;

    const rawDate =
      meta('meta[property="article:published_time"]') ??
      meta('meta[name="article:published_time"]') ??
      meta('meta[property="og:published_time"]') ??
      meta('meta[name="pubdate"]') ??
      meta('meta[name="publish-date"]') ??
      meta('meta[name="date"]') ??
      meta('meta[itemprop="datePublished"]') ??
      doc.querySelector('time[datetime]')?.getAttribute('datetime') ??
      null;

    const parsedDate = rawDate ? Date.parse(rawDate) : NaN;

    return {
      title: meta('meta[property="og:title"]') ?? doc.title?.trim() ?? null,
      author:
        meta('meta[name="author"]') ??
        meta('meta[property="article:author"]') ??
        doc.querySelector('[rel="author"]')?.textContent?.trim() ??
        null,
      siteName: meta('meta[property="og:site_name"]'),
      publishedAt: Number.isFinite(parsedDate) ? parsedDate : null,
      leadImage: meta('meta[property="og:image"]') ?? meta('meta[name="twitter:image"]'),
    };
  }
}

/** Alt text publishers give their own logos and badges. */
const FURNITURE_ALT = /^(logo|accreditation|advertisement|advert|ad|sponsored|masthead|icon)$/i;

/**
 * True for a masthead or badge rather than article art: either the alt text
 * says so, or the image is wrapped in a link back to the publisher's own front
 * page, which no real article photograph is.
 */
function isPublisherFurniture(img: Element, baseUrl: string): boolean {
  const alt = img.getAttribute('alt')?.trim() ?? '';
  if (alt && FURNITURE_ALT.test(alt)) return true;

  const link = img.closest('a')?.getAttribute('href');
  if (!link) return false;

  try {
    const target = new URL(link, baseUrl);
    const article = new URL(baseUrl);
    const isRoot = target.pathname === '/' || target.pathname === '';
    return isRoot && target.hostname === article.hostname;
  } catch {
    return false;
  }
}

/**
 * Replaces video iframes with a marker paragraph the reader can render.
 *
 * It carries its own text so it survives the empty-node sweep and still reads
 * sensibly if nothing styles it.
 */
function markVideoEmbeds(html: string): string {
  const doc = new DOMParser().parseFromString(`<div id="cn-mark">${html}</div>`, 'text/html');
  const root = doc.getElementById('cn-mark');
  if (!root) return html;

  let replaced = 0;
  root.querySelectorAll('iframe[src], embed[src]').forEach((node) => {
    if (!VIDEO_EMBED_PATTERN.test(node.getAttribute('src') ?? '')) return;
    const marker = doc.createElement('p');
    marker.setAttribute('data-cn-video', '');
    marker.textContent = 'Video — watch on the original page';
    // Replaced in place, so an embed Readability did keep stays where it was.
    (node.closest('figure') ?? node).replaceWith(marker);
    replaced++;
  });

  return replaced ? root.innerHTML : html;
}

/** Block-level tags a leading byline or date could plausibly live in. */
const BLOCK_TAGS = new Set([
  'P', 'DIV', 'SECTION', 'ARTICLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'LI', 'FIGCAPTION', 'BLOCKQUOTE', 'TD', 'TH',
]);

const hasText = (element: Element): boolean =>
  (element.textContent?.trim().length ?? 0) > 0;

/**
 * The first block of prose in the body.
 *
 * Descends through wrapper divs — Readability's own container, plus whatever
 * the publisher nested it in — and past leading image-only blocks, to the
 * element that actually holds the first line of text. Inline elements resolve
 * up to their enclosing block, so a paragraph opening with a link is judged on
 * the whole sentence rather than the link text.
 */
function leadingTextBlock(root: Element): Element | null {
  let current: Element = root;

  for (let depth = 0; depth < 12; depth++) {
    const child = Array.from(current.children).find(hasText);
    if (!child) break;
    current = child;
  }

  if (current === root) return null;

  while (!BLOCK_TAGS.has(current.tagName)) {
    const parent = current.parentElement;
    if (!parent || parent === root) return null;
    current = parent;
  }

  return current === root ? null : current;
}

/** srcset is "url 320w, url 640w"; the last entry is the largest. */
function firstFromSrcset(srcset: string | null): string | null {
  if (!srcset) return null;
  const candidates = srcset
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);
  return candidates.length ? candidates[candidates.length - 1] : null;
}
