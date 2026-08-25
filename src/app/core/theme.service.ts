import { Injectable, effect, inject } from '@angular/core';
import { StatusBar, Style } from '@capacitor/status-bar';

import { SettingsService, ThemeChoice } from './settings.service';

/**
 * FR-6: light / dark / system theme, plus the persisted reader font size.
 * Both are applied to <html> so the reader's CSS can read them.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly settings = inject(SettingsService);
  private readonly media = window.matchMedia('(prefers-color-scheme: dark)');

  constructor() {
    // Re-apply whenever settings change, from anywhere.
    effect(() => {
      const { theme, fontSize } = this.settings.settings();
      this.applyTheme(theme);
      this.applyFontSize(fontSize);
    });

    this.media.addEventListener('change', () => {
      if (this.settings.settings().theme === 'system') this.applyTheme('system');
    });
  }

  private applyTheme(choice: ThemeChoice): void {
    const dark = choice === 'dark' || (choice === 'system' && this.media.matches);
    document.documentElement.classList.toggle('cn-dark', dark);
    document.documentElement.classList.toggle('ion-palette-dark', dark);

    StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }).catch(() => undefined);
  }

  private applyFontSize(px: number): void {
    document.documentElement.style.setProperty('--cn-reader-font-size', `${px}px`);
  }
}
