import { Injectable, inject, signal } from '@angular/core';

import { DbService } from './db.service';
import { CleanNews } from './clean-news.plugin';

/** Keys shared with android/.../data/Schema.kt (SettingKeys). */
export const SettingKeys = {
  pollIntervalMinutes: 'pollIntervalMinutes',
  guardianApiKey: 'guardianApiKey',
  theme: 'theme',
  fontSize: 'fontSize',
  listDensity: 'listDensity',
  imagesOnMobileData: 'imagesOnMobileData',
  curatedEnabled: 'curatedEnabled',
  lastRefreshAt: 'lastRefreshAt',
  downloadHintSeen: 'downloadHintSeen',
} as const;

export type ThemeChoice = 'light' | 'dark' | 'system';

/**
 * How much room one article gets in the list.
 *
 * Small drops the excerpt entirely rather than shrinking it: a two-line summary
 * set any smaller stops being readable and becomes texture, and the point of
 * the compact tier is to fit more *headlines* on screen, not more text.
 */
export type ListDensity = 'small' | 'medium' | 'large';

export interface AppSettings {
  /** FR-1: default 30 minutes, configurable 15 minutes to 6 hours. */
  pollIntervalMinutes: number;
  guardianApiKey: string;
  theme: ThemeChoice;
  /** FR-6: reader body size in px, persisted across sessions. */
  fontSize: number;
  /** FR-5: default on. */
  imagesOnMobileData: boolean;
  listDensity: ListDensity;
  /** FR-3: show the "For you" picks above the list. */
  curatedEnabled: boolean;
}

export const POLL_INTERVAL_MIN = 15;
export const POLL_INTERVAL_MAX = 360;
export const FONT_SIZE_MIN = 15;
export const FONT_SIZE_MAX = 26;

const DEFAULTS: AppSettings = {
  pollIntervalMinutes: 30,
  guardianApiKey: '',
  theme: 'system',
  fontSize: 19,
  imagesOnMobileData: true,
  listDensity: 'medium',
  curatedEnabled: true,
};

@Injectable({ providedIn: 'root' })
export class SettingsService {
  /** Read synchronously all over the UI; loaded once at startup. */
  readonly settings = signal<AppSettings>({ ...DEFAULTS });

  private loaded = false;

  private readonly db = inject(DbService);

  async load(): Promise<AppSettings> {
    if (this.loaded) return this.settings();

    const rows = await this.db.query<{ key: string; value: string }>(
      'SELECT key, value FROM settings',
    );
    const map = new Map(rows.map((r) => [r.key, r.value]));

    const next: AppSettings = {
      pollIntervalMinutes: clamp(
        parseInt(map.get(SettingKeys.pollIntervalMinutes) ?? '', 10) || DEFAULTS.pollIntervalMinutes,
        POLL_INTERVAL_MIN,
        POLL_INTERVAL_MAX,
      ),
      guardianApiKey: map.get(SettingKeys.guardianApiKey) ?? DEFAULTS.guardianApiKey,
      theme: (map.get(SettingKeys.theme) as ThemeChoice) ?? DEFAULTS.theme,
      fontSize: clamp(
        parseInt(map.get(SettingKeys.fontSize) ?? '', 10) || DEFAULTS.fontSize,
        FONT_SIZE_MIN,
        FONT_SIZE_MAX,
      ),
      imagesOnMobileData:
        (map.get(SettingKeys.imagesOnMobileData) ?? '1') === '1',
      listDensity: readDensity(map.get(SettingKeys.listDensity)),
      curatedEnabled: (map.get(SettingKeys.curatedEnabled) ?? '1') === '1',
    };

    this.settings.set(next);
    this.loaded = true;
    return next;
  }

  async update(patch: Partial<AppSettings>): Promise<void> {
    const current = this.settings();
    const next: AppSettings = { ...current, ...patch };
    if (patch.pollIntervalMinutes !== undefined) {
      next.pollIntervalMinutes = clamp(patch.pollIntervalMinutes, POLL_INTERVAL_MIN, POLL_INTERVAL_MAX);
    }
    if (patch.fontSize !== undefined) {
      next.fontSize = clamp(patch.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX);
    }

    await Promise.all([
      this.db.putSetting(SettingKeys.pollIntervalMinutes, String(next.pollIntervalMinutes)),
      this.db.putSetting(SettingKeys.guardianApiKey, next.guardianApiKey),
      this.db.putSetting(SettingKeys.theme, next.theme),
      this.db.putSetting(SettingKeys.fontSize, String(next.fontSize)),
      this.db.putSetting(SettingKeys.imagesOnMobileData, next.imagesOnMobileData ? '1' : '0'),
      this.db.putSetting(SettingKeys.listDensity, next.listDensity),
      this.db.putSetting(SettingKeys.curatedEnabled, next.curatedEnabled ? '1' : '0'),
    ]);

    this.settings.set(next);

    // A new cadence has to reach WorkManager now, not at the next period end.
    if (patch.pollIntervalMinutes !== undefined && patch.pollIntervalMinutes !== current.pollIntervalMinutes) {
      await CleanNews.reschedulePolling();
    }
  }

  /**
   * One-off UI state rather than a preference, so it is read and written
   * directly instead of joining AppSettings — nothing in the settings screen
   * shows it, and it should not be rewritten every time something else changes.
   */
  async downloadHintSeen(): Promise<boolean> {
    return (await this.db.getSetting(SettingKeys.downloadHintSeen)) === '1';
  }

  async markDownloadHintSeen(): Promise<void> {
    await this.db.putSetting(SettingKeys.downloadHintSeen, '1');
  }

  async lastRefreshAt(): Promise<number | null> {
    const raw = await this.db.getSetting(SettingKeys.lastRefreshAt);
    const parsed = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  }
}

/** An unrecognised stored value falls back rather than reaching the class list. */
function readDensity(raw: string | undefined): ListDensity {
  return raw === 'small' || raw === 'large' ? raw : DEFAULTS.listDensity;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
