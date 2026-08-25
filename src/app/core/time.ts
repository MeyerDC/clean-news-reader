/**
 * Relative timestamps in the widget's format — "22 min ago" (FR-3), reused in
 * the in-app list so both surfaces read the same way.
 */
export function relativeTime(timestamp: number | null | undefined, now = Date.now()): string {
  if (!timestamp) return '';

  const seconds = Math.round((now - timestamp) / 1000);
  if (seconds < 0) return 'just now'; // Clock skew in a feed's pubDate.
  if (seconds < 60) return 'just now';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;

  const days = Math.round(hours / 24);
  if (days < 7) return days === 1 ? 'yesterday' : `${days} days ago`;

  return new Date(timestamp).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: sameYear(timestamp, now) ? undefined : 'numeric',
  });
}

/** FR-6: "estimated read time", at a middling 220 words per minute. */
export function readingTime(text: string | null | undefined): string | null {
  if (!text) return null;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words < 30) return null;
  return `${Math.max(1, Math.round(words / 220))} min read`;
}

export function formatDate(timestamp: number | null | undefined): string {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 0.1) return `${Math.round(bytes / 1024)} KB`;
  return `${mb.toFixed(1)} MB`;
}

function sameYear(a: number, b: number): boolean {
  return new Date(a).getFullYear() === new Date(b).getFullYear();
}
