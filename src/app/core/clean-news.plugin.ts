import { registerPlugin, PluginListenerHandle } from '@capacitor/core';

/** A navigation instruction handed over from the native layer. */
export type NativeRoute =
  | { type: 'article'; articleId: number }
  | { type: 'share'; url: string }
  | { type: 'shareNoUrl' };

export interface CleanNewsPlugin {
  /**
   * Drains the intent that launched the app, if any. Called once at startup so
   * a widget tap or a share opens on the right screen (FR-3, FR-8).
   */
  consumePendingIntent(): Promise<{ route: NativeRoute | null }>;

  /** FR-9 pull-to-refresh: enqueue an immediate WorkManager poll. */
  pollNow(): Promise<void>;

  /** Applies a changed poll interval straight away (FR-11). */
  reschedulePolling(): Promise<{ intervalMinutes: number }>;

  /** Re-renders the home-screen widget after in-app state changes. */
  refreshWidget(): Promise<void>;
  /** FR-3: records that an article was read, for the curator to learn from. */
  recordRead(options: { articleId: number }): Promise<void>;

  /** FR-11: total bytes held by the image cache. */
  getCacheSize(): Promise<{ bytes: number }>;

  /** FR-10: clears cached articles and images, never saved articles. */
  clearCache(): Promise<{ removed: number }>;

  /** FR-6: "Delete from cache" for a single article. */
  deleteArticle(options: { articleId: number }): Promise<void>;

  /** The database name and image directory the native side owns (spec 4.1). */
  getDatabaseName(): Promise<{ name: string; imageDir: string }>;

  addListener(
    eventName: 'appIntent',
    listener: (route: NativeRoute) => void,
  ): Promise<PluginListenerHandle>;

  /**
   * Fires when a background poll run finishes, so the in-app list can catch up
   * with the widget instead of showing stale headlines until the next
   * navigation.
   */
  addListener(
    eventName: 'pollFinished',
    listener: (event: { stored: number }) => void,
  ): Promise<PluginListenerHandle>;
}

export const CleanNews = registerPlugin<CleanNewsPlugin>('CleanNews');
