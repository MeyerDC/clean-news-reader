import { Injectable, inject } from '@angular/core';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Network } from '@capacitor/network';

import { CachedImage } from './models';
import { DbService } from './db.service';
import { SettingsService } from './settings.service';

/** What the reader needs to render one image. */
export interface ReadyImage {
  remoteUrl: string;
  /** A webview-safe src for the file on disk. */
  src: string;
  width: number | null;
  height: number | null;
  caption: string | null;
}

/** Images are fetched a few at a time so a long article stays responsive. */
const CONCURRENCY = 3;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * FR-5: body images are downloaded and cached to the filesystem so a read
 * article stays readable offline (goal 4 / acceptance criterion 7).
 */
@Injectable({ providedIn: 'root' })
export class ImageCacheService {
  private readonly db = inject(DbService);
  private readonly settings = inject(SettingsService);

  /** Everything already on disk for this article, keyed by remote URL. */
  async cachedFor(articleId: number): Promise<Map<string, ReadyImage>> {
    const rows = await this.db.query<CachedImage>(
      'SELECT * FROM cached_images WHERE articleId = ? AND localPath IS NOT NULL',
      [articleId],
    );

    const map = new Map<string, ReadyImage>();
    for (const row of rows) {
      const src = await this.toWebviewSrc(row.localPath!);
      if (!src) continue;
      map.set(row.remoteUrl, {
        remoteUrl: row.remoteUrl,
        src,
        width: row.width,
        height: row.height,
        caption: row.caption,
      });
    }
    return map;
  }

  /**
   * FR-5: "Load images on mobile data" (default on). When it is off and we are
   * on cellular, already-cached images still show — we simply do not fetch new
   * ones.
   */
  async downloadsAllowed(): Promise<boolean> {
    if (this.settings.settings().imagesOnMobileData) return true;
    try {
      const status = await Network.getStatus();
      return status.connectionType !== 'cellular';
    } catch {
      return true;
    }
  }

  /**
   * Downloads any images not yet on disk, calling [onReady] as each lands so
   * the reader can swap them in without waiting for the whole set (failure-mode
   * table: a very long article must not block on all its images).
   */
  async cacheAll(
    articleId: number,
    images: { url: string; caption: string | null }[],
    onReady?: (image: ReadyImage) => void,
    /**
     * Fires after every attempt, not every success. A failed image is still
     * one fewer to wait for, and a progress bar that stalled at 80% because
     * one picture 404'd would look like the download had hung.
     */
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
    if (!images.length) return;
    if (!(await this.downloadsAllowed())) return;

    const existing = await this.cachedFor(articleId);
    const queue = images.filter((image) => !existing.has(image.url));
    onProgress?.(0, queue.length);

    let cursor = 0;
    let done = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (cursor < queue.length) {
        const item = queue[cursor++];
        const ready = await this.cacheOne(articleId, item.url, item.caption);
        if (ready && onReady) onReady(ready);
        onProgress?.(++done, queue.length);
      }
    });

    await Promise.all(workers);
  }

  /**
   * Fetches one image. Returns null on any failure — FR-5 says a failed image
   * is removed from the body rather than shown as a broken icon, so the caller
   * simply never receives it.
   */
  async cacheOne(
    articleId: number,
    remoteUrl: string,
    caption: string | null,
  ): Promise<ReadyImage | null> {
    try {
      const response = await CapacitorHttp.get({
        url: remoteUrl,
        responseType: 'blob',
        connectTimeout: 15000,
        readTimeout: 20000,
        headers: { Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
      });

      if (response.status < 200 || response.status >= 300) return null;

      const base64 = typeof response.data === 'string' ? response.data : null;
      if (!base64) return null;
      // base64 inflates by 4/3; check before writing rather than after.
      if (base64.length * 0.75 > MAX_IMAGE_BYTES) return null;

      const path = `${this.db.imageDir}/${fileNameFor(articleId, remoteUrl, response.headers)}`;

      await Filesystem.writeFile({
        path,
        data: base64,
        directory: Directory.Data,
        recursive: true,
      });

      const src = await this.toWebviewSrc(path);
      if (!src) return null;

      // Intrinsic size drives the placeholder's aspect ratio on the next read,
      // which is what keeps the page from jumping while the user is reading.
      const size = await measure(src);

      await this.db.run(
        `INSERT INTO cached_images (articleId, remoteUrl, localPath, width, height, caption)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(articleId, remoteUrl) DO UPDATE SET
           localPath = excluded.localPath,
           width = excluded.width,
           height = excluded.height,
           caption = COALESCE(excluded.caption, cached_images.caption)`,
        [articleId, remoteUrl, path, size?.width ?? null, size?.height ?? null, caption],
      );

      return {
        remoteUrl,
        src,
        width: size?.width ?? null,
        height: size?.height ?? null,
        caption,
      };
    } catch {
      return null;
    }
  }

  /** FR-5: the lead image renders above the body. */
  async cacheLeadImage(articleId: number, remoteUrl: string): Promise<string | null> {
    const existing = await this.cachedFor(articleId);
    const cached = existing.get(remoteUrl);
    if (cached) return cached.src;

    if (!(await this.downloadsAllowed())) return null;
    const ready = await this.cacheOne(articleId, remoteUrl, null);
    if (!ready) return null;

    await this.db.run('UPDATE articles SET leadImagePath = ? WHERE id = ?', [
      // Store the relative path; the webview src is derived per session.
      await this.pathFor(articleId, remoteUrl),
      articleId,
    ]);
    return ready.src;
  }

  private async pathFor(articleId: number, remoteUrl: string): Promise<string | null> {
    const row = await this.db.queryOne<{ localPath: string | null }>(
      'SELECT localPath FROM cached_images WHERE articleId = ? AND remoteUrl = ?',
      [articleId, remoteUrl],
    );
    return row?.localPath ?? null;
  }

  /** Converts a Data-relative path into something an <img> can load. */
  async toWebviewSrc(relativePath: string): Promise<string | null> {
    try {
      const { uri } = await Filesystem.getUri({
        directory: Directory.Data,
        path: relativePath,
      });
      return Capacitor.convertFileSrc(uri);
    } catch {
      return null;
    }
  }
}

/** Stable, collision-resistant name so the same URL maps to the same file. */
function fileNameFor(
  articleId: number,
  remoteUrl: string,
  headers: Record<string, string> | undefined,
): string {
  return `${articleId}-${hash(remoteUrl)}${extensionFor(remoteUrl, headers)}`;
}

function extensionFor(url: string, headers: Record<string, string> | undefined): string {
  const contentType = headerValue(headers, 'content-type')?.split(';')[0]?.trim().toLowerCase();
  const fromType: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/avif': '.avif',
    'image/svg+xml': '.svg',
  };
  if (contentType && fromType[contentType]) return fromType[contentType];

  const match = /\.(jpe?g|png|gif|webp|avif|svg)(?:$|\?)/i.exec(url);
  return match ? `.${match[1].toLowerCase().replace('jpeg', 'jpg')}` : '.img';
}

function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((h) => h.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

/** djb2 — short, stable, and good enough to key a filename. */
function hash(value: string): string {
  let h = 5381;
  for (let i = 0; i < value.length; i++) {
    h = ((h << 5) + h + value.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** Reads intrinsic dimensions so we can reserve the right box next time. */
function measure(src: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const image = new Image();
    const done = (result: { width: number; height: number } | null) => {
      image.onload = null;
      image.onerror = null;
      resolve(result);
    };
    image.onload = () =>
      done(
        image.naturalWidth && image.naturalHeight
          ? { width: image.naturalWidth, height: image.naturalHeight }
          : null,
      );
    image.onerror = () => done(null);
    image.src = src;
  });
}
