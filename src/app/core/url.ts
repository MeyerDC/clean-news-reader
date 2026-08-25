/**
 * URL normalisation for article identity (spec section 6).
 *
 * This is a deliberate mirror of the Kotlin implementation in
 * android/.../data/UrlNormalizer.kt. Both sides insert into the same `articles`
 * table keyed on the normalised URL, so if the two ever disagree the same story
 * ends up stored twice. Change them together.
 */

const TRACKING_PARAMS = new Set(
  [
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'utm_id', 'utm_name', 'utm_reader', 'utm_brand', 'utm_social',
    'utm_social-type', 'utm_swu',
    'fbclid', 'gclid', 'gclsrc', 'dclid', 'msclkid', 'twclid', 'igshid',
    'mc_cid', 'mc_eid', '_ga', '_gl', 'yclid', 'wbraid', 'gbraid',
    'ref', 'ref_src', 'ref_url', 'referrer', 'source', 'cmpid', 'cmp',
    'sfnsn', 'spm', 'at_medium', 'at_campaign', 'at_custom1',
    'at_custom2', 'at_custom3', 'at_custom4', 'ito', 'ns_campaign',
    'ns_mchannel', 'ns_source', 'ns_linkname', 'ns_fee', 'smid',
    'partner', 'sharetoken', '__twitter_impression', 'guccounter',
    'guce_referrer', 'guce_referrer_sig',
  ].map((p) => p.toLowerCase()),
);

const TRACKING_PREFIXES = ['utm_', 'at_custom', 'pk_', 'piwik_', 'hsa_'];

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return TRACKING_PARAMS.has(lower) || TRACKING_PREFIXES.some((p) => lower.startsWith(p));
}

export function normalizeUrl(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  const scheme = parsed.protocol.replace(':', '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return null;

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return null;

  // URL already drops the default port, so `parsed.port` is '' for 80/443.
  const authority = parsed.port ? `${host}:${parsed.port}` : host;

  let path = parsed.pathname || '/';
  if (path.length > 1) path = path.replace(/\/+$/, '');
  if (!path) path = '/';

  const kept: [string, string][] = [];
  parsed.searchParams.forEach((value, name) => {
    if (!isTrackingParam(name)) kept.push([name, value]);
  });
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const query = kept
    .map(([name, value]) =>
      value === '' ? encodeURIComponent(name) : `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    )
    .join('&');

  // The fragment is always dropped: #comments and #main are the same page.
  return `${scheme}://${authority}${path}${query ? `?${query}` : ''}`;
}

/** FR-8: pull the first http(s) URL out of arbitrary shared text. */
export function firstUrlIn(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = /https?:\/\/[^\s<>"')\]]+/.exec(text);
  if (!match) return null;
  // Shared text often ends a sentence immediately after the link.
  return normalizeUrl(match[0].replace(/[.,;:!?]+$/, ''));
}

/** Best-effort display name for a source we have no feed record for. */
export function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Resolves a possibly-relative asset URL found inside extracted HTML. */
export function resolveUrl(base: string, candidate: string): string | null {
  try {
    return new URL(candidate, base).toString();
  } catch {
    return null;
  }
}
