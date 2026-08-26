/**
 * Publishers put furniture in their headlines. Daily Maverick leads with a
 * section in capitals ("WHAT'S COOKING:"), RugbyPass trails a series name
 * ("| Flight Centre Series 2026"), the Guardian trails a newsletter ("| First
 * Thing"). Set at headline size and weight it shouts, and in a list of forty
 * it is most of what the eye sees.
 *
 * Split display-only: the stored title keeps every word, so search still
 * matches what the publisher wrote and the article view still shows it whole.
 */
export interface SplitHeadline {
  /** The section or series, if the title carried one. */
  kicker: string | null;
  headline: string;
}

/** Longer than this is not a label, it is part of the sentence. */
const MAX_KICKER = 28;

/** Below this the remainder is too short to stand as a headline on its own. */
const MIN_HEADLINE = 20;

export function splitHeadline(rawTitle: string): SplitHeadline {
  const title = (rawTitle ?? '').trim();
  if (!title) return { kicker: null, headline: '' };

  const trailing = stripTrailingBrand(title);
  const leading = liftLeadingKicker(trailing);
  return leading;
}

/**
 * A leading kicker is recognised by *case*, not by position: "PARLIAMENT:" is
 * furniture, "Plum:" and "Damian McKenzie:" are the story. Requiring the whole
 * prefix to be free of lowercase is what separates them, and it is the reason
 * this can run on every row without a per-publisher list.
 */
function liftLeadingKicker(title: string): SplitHeadline {
  const at = firstSeparator(title);
  if (at < 0) return { kicker: null, headline: title };

  const prefix = title.slice(0, at).trim();
  const rest = title.slice(at + 1).trim();

  if (prefix.length < 2 || prefix.length > MAX_KICKER) return { kicker: null, headline: title };
  if (rest.length < MIN_HEADLINE) return { kicker: null, headline: title };
  // No lowercase anywhere in the prefix, and at least one letter to be a word.
  if (!/[A-Z]/.test(prefix) || /[a-z]/.test(prefix)) return { kicker: null, headline: title };
  // An all-capitals headline would otherwise donate its first clause as a
  // kicker and keep shouting the rest.
  if (!/[a-z]/.test(rest)) return { kicker: null, headline: title };

  return { kicker: titleCase(prefix), headline: rest };
}

/**
 * A trailing "| Something" is the series or newsletter the piece ran in. It is
 * dropped rather than kept as a second label: it repeats down the whole list,
 * and the feed name already says where the article came from.
 */
function stripTrailingBrand(title: string): string {
  const at = title.lastIndexOf('|');
  if (at < 0) return title;

  const head = title.slice(0, at).trim();
  const tail = title.slice(at + 1).trim();

  if (!tail || tail.length > 32) return title;
  if (head.length < MIN_HEADLINE + 5) return title;
  // A tail with its own punctuation is a clause, not a label.
  if (/[.:;?!]/.test(tail)) return title;

  return head;
}

/** ":" or "|", whichever comes first. */
function firstSeparator(title: string): number {
  const colon = title.indexOf(':');
  const pipe = title.indexOf('|');
  if (colon < 0) return pipe;
  if (pipe < 0) return colon;
  return Math.min(colon, pipe);
}

/**
 * Shown small and letter-spaced, so the capitals are re-set rather than
 * reproduced — the point was to stop the row shouting.
 */
function titleCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/(^|[\s(\-–—/])([a-z])/g, (_, before: string, letter: string) => before + letter.toUpperCase())
    // Keep the short forms that look wrong in title case.
    .replace(/\bOp-ed\b/g, 'Op-Ed')
    .replace(/\bSa\b/g, 'SA');
}
