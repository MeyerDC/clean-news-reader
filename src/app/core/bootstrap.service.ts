import { Injectable, inject, signal } from '@angular/core';

import { DbService } from './db.service';
import { SettingsService } from './settings.service';
import { ThemeService } from './theme.service';
import { IntentService } from './intent.service';
import { PollService } from './poll.service';
import { SearchService } from './search.service';
import { CleanNews } from './clean-news.plugin';

/**
 * Startup sequence. Order matters: the database has to be open before settings
 * can load, settings drive the theme, and intent routing must run last so it
 * can navigate over whatever the router put up first.
 */
@Injectable({ providedIn: 'root' })
export class BootstrapService {
  readonly ready = signal(false);
  readonly fatalError = signal<string | null>(null);

  private readonly db = inject(DbService);
  private readonly settings = inject(SettingsService);
  private readonly theme = inject(ThemeService);
  private readonly intents = inject(IntentService);
  private readonly polls = inject(PollService);
  private readonly search = inject(SearchService);

  async run(): Promise<void> {
    try {
      await this.db.ready();
      await this.settings.load();
      // Injecting ThemeService is what starts it; the reference keeps the
      // dependency honest for anyone reading this.
      void this.theme;

      this.ready.set(true);

      // Non-fatal: the app is usable even if these do not land.
      await this.polls.start().catch(() => undefined);
      await this.intents.start().catch(() => undefined);
      await CleanNews.refreshWidget().catch(() => undefined);

      // Not awaited: the background poll may have written hundreds of rows
      // while the app was closed, and the list should not wait on indexing
      // them. Search simply catches up in the background.
      void this.search.catchUp().catch(() => undefined);
    } catch (error) {
      this.fatalError.set(
        error instanceof Error ? error.message : 'Koppie & Print could not start.',
      );
    }
  }
}
