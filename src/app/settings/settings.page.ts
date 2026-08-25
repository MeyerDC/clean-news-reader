import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  IonContent,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonButtons,
  IonBackButton,
  IonList,
  IonListHeader,
  IonItem,
  IonLabel,
  IonNote,
  IonToggle,
  IonSelect,
  IonSelectOption,
  IonRange,
  IonInput,
  IonReorderGroup,
  IonReorder,
  IonIcon,
  IonButton,
  AlertController,
  ToastController,
} from '@ionic/angular';
import type { ItemReorderEventDetail } from '@ionic/angular';
import { addIcons } from 'ionicons';
import { addOutline, trashOutline, warningOutline, refreshOutline } from 'ionicons/icons';

import { Feed } from '../core/models';
import { FeedService } from '../core/feed.service';
import {
  SettingsService,
  ThemeChoice,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  POLL_INTERVAL_MAX,
  POLL_INTERVAL_MIN,
} from '../core/settings.service';
import { CleanNews } from '../core/clean-news.plugin';
import { DiscoveredFeed, FeedDiscoveryService } from '../core/feed-discovery.service';
import { SearchService } from '../core/search.service';
import { formatBytes, relativeTime } from '../core/time';

/** FR-1: 15 minutes to 6 hours. Offered as sensible steps, not a free number. */
const POLL_CHOICES = [15, 30, 60, 120, 240, 360];

@Component({
  selector: 'app-settings',
  templateUrl: 'settings.page.html',
  styleUrls: ['settings.page.scss'],
  imports: [
    FormsModule,
    IonContent, IonHeader, IonToolbar, IonTitle, IonButtons, IonBackButton,
    IonList, IonListHeader, IonItem, IonLabel, IonNote, IonToggle,
    IonSelect, IonSelectOption, IonRange, IonInput,
    IonReorderGroup, IonReorder, IonIcon, IonButton,
  ],
})
export class SettingsPage implements OnInit {
  private readonly feedService = inject(FeedService);
  private readonly discovery = inject(FeedDiscoveryService);
  protected readonly search = inject(SearchService);
  private readonly alerts = inject(AlertController);
  private readonly toasts = inject(ToastController);
  protected readonly settings = inject(SettingsService);

  protected readonly feeds = signal<Feed[]>([]);
  protected readonly cacheBytes = signal(0);
  protected readonly finding = signal(false);
  protected readonly searchStats = signal({ indexed: 0, withBody: 0, archived: 0 });

  protected readonly pollChoices = POLL_CHOICES;
  protected readonly fontMin = FONT_SIZE_MIN;
  protected readonly fontMax = FONT_SIZE_MAX;
  protected readonly pollMin = POLL_INTERVAL_MIN;
  protected readonly pollMax = POLL_INTERVAL_MAX;

  constructor() {
    addIcons({ addOutline, trashOutline, warningOutline, refreshOutline });
  }

  async ngOnInit(): Promise<void> {
    await this.reload();
  }

  private async reload(): Promise<void> {
    const [feeds, cache, stats] = await Promise.all([
      this.feedService.list(),
      CleanNews.getCacheSize().catch(() => ({ bytes: 0 })),
      this.search.stats().catch(() => ({ indexed: 0, withBody: 0, archived: 0 })),
    ]);
    this.feeds.set(feeds);
    this.cacheBytes.set(cache.bytes);
    this.searchStats.set(stats);
  }

  // ---- feeds (FR-11) ----------------------------------------------------

  /**
   * Takes a site address as readily as a feed address. Most publishers no
   * longer declare their feed in the page, so this probes the conventional
   * paths too — which is how it finds the majority of them.
   */
  protected async addFeed(): Promise<void> {
    const alert = await this.alerts.create({
      header: 'Add a source',
      message: 'Paste a website or a feed address.',
      inputs: [{ name: 'url', type: 'url', placeholder: 'https://example.com' }],
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Find feed',
          handler: (data: { url: string }) => {
            void this.findFeed(data.url);
          },
        },
      ],
    });
    await alert.present();
  }

  private async findFeed(rawUrl: string): Promise<void> {
    const url = (rawUrl ?? '').trim();
    if (!url) return;

    this.finding.set(true);
    try {
      // If it is already a feed, take it at its word rather than crawling.
      const direct = await this.discovery.validate(withScheme(url));
      if (direct) {
        await this.addDiscovered({ ...direct, via: 'declared' });
        return;
      }

      const found = await this.discovery.discover(withScheme(url));
      if (!found.length) {
        await this.toast('No feed found on that site.');
        return;
      }
      if (found.length === 1) {
        await this.addDiscovered(found[0]);
        return;
      }
      await this.pickFeed(found);
    } catch (error) {
      await this.toast(error instanceof Error ? error.message : 'Could not check that address.');
    } finally {
      this.finding.set(false);
    }
  }

  /** A site with several feeds is common enough to be worth asking about. */
  private async pickFeed(found: DiscoveredFeed[]): Promise<void> {
    const alert = await this.alerts.create({
      header: 'Which feed?',
      inputs: found.map((feed, index) => ({
        type: 'radio' as const,
        label: `${feed.title} (${feed.itemCount})`,
        value: index,
        checked: index === 0,
      })),
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Add',
          handler: (index: number) => {
            void this.addDiscovered(found[index ?? 0]);
          },
        },
      ],
    });
    await alert.present();
  }

  private async addDiscovered(feed: DiscoveredFeed): Promise<void> {
    try {
      await this.feedService.addDiscovered(feed);
      await this.reload();
      await this.toast(`Added ${feed.title}. Refreshing now.`);
    } catch (error) {
      await this.toast(error instanceof Error ? error.message : 'Could not add that feed.');
    }
  }

  protected async removeFeed(feed: Feed): Promise<void> {
    const alert = await this.alerts.create({
      header: `Remove ${feed.sourceName}?`,
      message: 'Articles already downloaded stay until they expire.',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Remove',
          role: 'destructive',
          handler: () => {
            void this.doRemoveFeed(feed);
          },
        },
      ],
    });
    await alert.present();
  }

  private async doRemoveFeed(feed: Feed): Promise<void> {
    await this.feedService.remove(feed.id);
    await this.reload();
  }

  protected async toggleFeed(feed: Feed, enabled: boolean): Promise<void> {
    await this.feedService.setEnabled(feed.id, enabled);
    this.feeds.update((list) =>
      list.map((f) => (f.id === feed.id ? { ...f, enabled } : f)),
    );
  }

  protected async reorderFeeds(event: CustomEvent<ItemReorderEventDetail>): Promise<void> {
    const ordered = event.detail.complete(this.feeds()) as Feed[];
    this.feeds.set(ordered);
    await this.feedService.reorder(ordered.map((f) => f.id));
  }

  protected isFailing(feed: Feed): boolean {
    return this.feedService.isFailing(feed);
  }

  protected feedStatus(feed: Feed): string {
    if (this.isFailing(feed)) {
      return `Failing (${feed.consecutiveFailures} polls): ${feed.lastError ?? 'unknown error'}`;
    }
    if (feed.lastError) return `Last error: ${feed.lastError}`;
    if (feed.lastPolledAt) return `Checked ${relativeTime(feed.lastPolledAt)}`;
    return 'Not checked yet';
  }

  protected async refreshFeeds(): Promise<void> {
    await this.feedService.refreshNow();
    await this.toast('Refreshing in the background.');
  }

  // ---- preferences ------------------------------------------------------

  protected async setPollInterval(minutes: number): Promise<void> {
    await this.settings.update({ pollIntervalMinutes: minutes });
  }

  protected async setTheme(theme: ThemeChoice): Promise<void> {
    await this.settings.update({ theme });
  }

  protected async setFontSize(size: number): Promise<void> {
    await this.settings.update({ fontSize: size });
  }

  protected async setImagesOnMobileData(value: boolean): Promise<void> {
    await this.settings.update({ imagesOnMobileData: value });
  }

  protected async setGuardianKey(value: string): Promise<void> {
    await this.settings.update({ guardianApiKey: value.trim() });
  }

  protected pollLabel(minutes: number): string {
    if (minutes < 60) return `Every ${minutes} minutes`;
    const hours = minutes / 60;
    return hours === 1 ? 'Every hour' : `Every ${hours} hours`;
  }

  // ---- cache (FR-10) ----------------------------------------------------

  protected get cacheLabel(): string {
    return formatBytes(this.cacheBytes());
  }

  protected async clearCache(): Promise<void> {
    const alert = await this.alerts.create({
      header: 'Clear cache?',
      message: 'Downloaded articles and images are removed. Saved articles are kept.',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Clear',
          role: 'destructive',
          handler: () => {
            void this.doClearCache();
          },
        },
      ],
    });
    await alert.present();
  }

  private async doClearCache(): Promise<void> {
    const { removed } = await CleanNews.clearCache();
    await this.reload();
    await this.toast(`Cleared ${removed} article${removed === 1 ? '' : 's'}.`);
  }

  private async toast(message: string): Promise<void> {
    const toast = await this.toasts.create({ message, duration: 2200, position: 'bottom' });
    await toast.present();
  }
}

/** People paste "example.com"; the discovery fetch needs a scheme. */
function withScheme(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}
