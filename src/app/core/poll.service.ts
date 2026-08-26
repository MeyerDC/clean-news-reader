import { Injectable, inject, signal } from '@angular/core';

import { CleanNews } from './clean-news.plugin';
import { SearchService } from './search.service';
import { SyncService } from './sync/sync.service';

/**
 * Watches the native polling job so the UI can react to it.
 *
 * FR-9's pull-to-refresh hands the work to WorkManager, which finishes on its
 * own schedule. Waiting for the real completion event — rather than guessing
 * with a timer — is what makes the spinner mean something.
 */
@Injectable({ providedIn: 'root' })
export class PollService {
  private readonly search = inject(SearchService);
  private readonly sync = inject(SyncService);

  /** Increments on every completed poll run. */
  readonly completed = signal(0);

  private started = false;
  private waiters: (() => void)[] = [];

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    await CleanNews.addListener('pollFinished', () => {
      this.completed.update((n) => n + 1);
      // New articles arrived from the native job, which cannot touch the
      // search index itself.
      void this.search.catchUp().catch(() => undefined);
      // A linked account reconciles on the same cadence rather than running a
      // scheduler of its own.
      void this.syncThenIndex();
      const pending = this.waiters;
      this.waiters = [];
      pending.forEach((resolve) => resolve());
    });
  }

  /** Sync writes articles, so the index has to catch up afterwards too. */
  private async syncThenIndex(): Promise<void> {
    if (!this.sync.linked) return;
    try {
      await this.sync.sync();
      await this.search.catchUp();
      this.completed.update((n) => n + 1);
    } catch {
      // A failed sync must not disturb the local poll that just succeeded.
    }
  }

  /** Triggers a poll and resolves when it finishes, or when it takes too long. */
  async refreshNow(timeoutMs = 20000): Promise<void> {
    const finished = new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      // A poll that is wedged behind a slow feed must not pin the spinner
      // open; the list still reloads from whatever did land.
      setTimeout(resolve, timeoutMs);
    });

    await CleanNews.pollNow();
    await finished;
  }
}
