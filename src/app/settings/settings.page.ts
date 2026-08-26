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
  IonSegment,
  IonSegmentButton,
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

import { Router } from '@angular/router';

import { Feed, Topic } from '../core/models';
import { FeedService } from '../core/feed.service';
import { TopicService } from '../core/topic.service';
import {
  ListDensity,
  SettingsService,
  ThemeChoice,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  POLL_INTERVAL_MAX,
  POLL_INTERVAL_MIN,
} from '../core/settings.service';
import { CleanNews } from '../core/clean-news.plugin';
import { DiscoveredFeed, FeedDiscoveryService, describeFeed } from '../core/feed-discovery.service';
import { SearchService } from '../core/search.service';
import { PendingFeedPush, SyncService } from '../core/sync/sync.service';
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
    IonSelect, IonSelectOption, IonRange, IonInput, IonSegment, IonSegmentButton,
    IonReorderGroup, IonReorder, IonIcon, IonButton,
  ],
})
export class SettingsPage implements OnInit {
  private readonly feedService = inject(FeedService);
  private readonly discovery = inject(FeedDiscoveryService);
  private readonly topicService = inject(TopicService);
  private readonly router = inject(Router);
  protected readonly search = inject(SearchService);
  protected readonly sync = inject(SyncService);
  private readonly alerts = inject(AlertController);
  private readonly toasts = inject(ToastController);
  protected readonly settings = inject(SettingsService);

  protected readonly feeds = signal<Feed[]>([]);
  protected readonly topics = signal<Topic[]>([]);
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
    const [feeds, topics, cache, stats] = await Promise.all([
      this.feedService.list(),
      this.topicService.list().catch(() => []),
      CleanNews.getCacheSize().catch(() => ({ bytes: 0 })),
      this.search.stats().catch(() => ({ indexed: 0, withBody: 0, archived: 0 })),
    ]);
    this.feeds.set(feeds);
    this.topics.set(topics);
    this.cacheBytes.set(cache.bytes);
    this.searchStats.set(stats);
    await this.sync.load().catch(() => undefined);
  }

  /** The editor is its own page, so the list has to catch up on the way back. */
  ionViewWillEnter(): void {
    void this.reload();
  }

  // ---- topics -------------------------------------------------------------

  protected newTopic(): void {
    void this.router.navigate(['/topics', 'new']);
  }

  protected editTopic(topic: Topic): void {
    void this.router.navigate(['/topics', topic.id]);
  }

  /** Says what the rule is made of, not what it currently catches. */
  protected describeTopic(topic: Topic): string {
    const parts: string[] = [];
    if (topic.feedIds.length) {
      parts.push(`${topic.feedIds.length} feed${topic.feedIds.length === 1 ? '' : 's'}`);
    }
    if (topic.categories.length) {
      parts.push(`${topic.categories.length} categor${topic.categories.length === 1 ? 'y' : 'ies'}`);
    }
    if (topic.keywords.length) {
      parts.push(topic.keywords.join(', '));
    }
    return parts.length ? parts.join('  ·  ') : 'No rules yet';
  }

  // ---- sync ---------------------------------------------------------------

  /**
   * NewsBlur has no OAuth without a client ID issued by its maintainer, so this
   * asks for the password directly. It is used once to obtain a session and is
   * never written anywhere — see SyncService.
   */
  protected async linkAccount(): Promise<void> {
    const alert = await this.alerts.create({
      header: 'Link NewsBlur',
      message: 'Your feeds and read state sync. The password is used to sign in and is not stored.',
      inputs: [
        { name: 'username', type: 'text', placeholder: 'NewsBlur username' },
        { name: 'password', type: 'password', placeholder: 'Password' },
      ],
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Link',
          handler: (data: { username: string; password: string }) => {
            void this.doLink(data.username, data.password);
          },
        },
      ],
    });
    await alert.present();
  }

  private async doLink(username: string, password: string): Promise<void> {
    this.finding.set(true);
    try {
      const identity = await this.sync.link('newsblur', username, password);
      await this.toast(`Linked as ${identity.username}. Syncing…`);
      const result = await this.sync.sync();
      await this.reload();
      await this.toast(`${result.feeds} feeds, ${result.articles} new articles.`);
      await this.offerFeedPush();
    } catch (error) {
      await this.toast(error instanceof Error ? error.message : 'Could not link that account.');
    } finally {
      this.finding.set(false);
    }
  }

  protected async syncNow(): Promise<void> {
    try {
      const result = await this.sync.sync();
      await this.reload();
      await this.toast(
        `${result.articles} new · ${result.pushed} read state${result.pushed === 1 ? '' : 's'} sent.`,
      );
      await this.offerFeedPush();
    } catch (error) {
      await this.toast(error instanceof Error ? error.message : 'Sync failed.');
    }
  }

  /**
   * Adding a feed to NewsBlur writes to someone's account and shows up on
   * their other devices, so it is never silent: the feeds are named and
   * confirmed. Declining is not remembered — the offer returns next sync,
   * which is the point, since the alternative is two lists quietly drifting.
   */
  private async offerFeedPush(): Promise<void> {
    const pending = await this.sync.pendingFeedPushes();
    if (!pending.length) return;

    const names = pending.map((feed) => feed.sourceName || feed.url);
    const alert = await this.alerts.create({
      header: `Add ${pending.length} feed${pending.length === 1 ? '' : 's'} to NewsBlur?`,
      // One sentence rather than paragraphs: an Ionic alert message is plain
      // text, so newlines collapse and the list runs into the explanation.
      // Feed titles come from publisher XML, so they are never marked up here.
      message:
        `These are on this phone but not in your NewsBlur account: ${names.join(', ')}. ` +
        'Adding them makes them appear wherever you read NewsBlur.',
      buttons: [
        { text: 'Not now', role: 'cancel' },
        {
          text: 'Add',
          handler: () => {
            void this.doPushFeeds(pending);
          },
        },
      ],
    });
    await alert.present();
  }

  private async doPushFeeds(pending: PendingFeedPush[]): Promise<void> {
    try {
      const { added, failed } = await this.sync.pushFeeds(pending);
      await this.reload();
      await this.toast(
        failed.length
          ? `Added ${added}. NewsBlur refused: ${failed.join(', ')}.`
          : `Added ${added} feed${added === 1 ? '' : 's'} to NewsBlur.`,
      );
    } catch (error) {
      await this.toast(error instanceof Error ? error.message : 'Could not add those feeds.');
    }
  }

  protected async unlinkAccount(): Promise<void> {
    const alert = await this.alerts.create({
      header: 'Unlink NewsBlur?',
      message: 'Syncing stops. Your feeds and articles stay on this device.',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Unlink',
          role: 'destructive',
          handler: () => {
            void this.doUnlink();
          },
        },
      ],
    });
    await alert.present();
  }

  private async doUnlink(): Promise<void> {
    await this.sync.unlink();
    await this.reload();
    await this.toast('Unlinked.');
  }

  protected get syncStatus(): string {
    const state = this.sync.state();
    if (!state.provider) return 'Not linked — this device polls feeds itself';
    const when = state.lastSyncedAt ? `synced ${relativeTime(state.lastSyncedAt)}` : 'not synced yet';
    return `${state.account} · ${when}`;
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
      // Labelled by freshness, not size. Two feeds with ten entries each tell
      // you nothing; "updated today" versus "archive" tells you everything.
      inputs: found.map((feed, index) => ({
        type: 'radio' as const,
        label: `${feed.title} — ${describeFeed(feed)}`,
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
      // Offered here rather than at the next sync: a feed you just added is
      // the one moment you actually know whether you want it on your laptop.
      await this.offerFeedPush();
    } catch (error) {
      await this.toast(error instanceof Error ? error.message : 'Could not add that feed.');
    }
  }

  protected async removeFeed(feed: Feed): Promise<void> {
    // A synced feed is being unsubscribed from an account, not just hidden on
    // this phone, and that is not something to discover afterwards.
    const message = feed.remoteId
      ? 'This also unsubscribes your NewsBlur account, so it goes everywhere ' +
        'you read. Articles already downloaded stay until they expire.'
      : 'Articles already downloaded stay until they expire.';

    const alert = await this.alerts.create({
      header: `Remove ${feed.sourceName}?`,
      message,
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

    // The tombstone is queued either way; pushing now just means the laptop
    // agrees in seconds rather than at the next sync.
    if (feed.remoteId && this.sync.linked) {
      await this.sync.sync().catch(() => undefined);
      await this.reload();
    }
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

  /**
   * A feed can poll perfectly and still deliver nothing, because every item is
   * older than the ingest cutoff. That reads as healthy and is the single most
   * confusing state the app can be in, so it gets said out loud.
   */
  protected feedStatus(feed: Feed): string {
    if (this.isFailing(feed)) {
      return `Failing (${feed.consecutiveFailures} polls): ${feed.lastError ?? 'unknown error'}`;
    }
    if (feed.lastError) return `Last error: ${feed.lastError}`;
    if (!feed.lastPolledAt) return 'Not checked yet';

    const stale = this.staleness(feed);
    if (stale) return stale;
    return `Checked ${relativeTime(feed.lastPolledAt)}`;
  }

  /** Null when the feed is behaving; otherwise the reason it looks quiet. */
  private staleness(feed: Feed): string | null {
    const day = 86_400_000;
    if (feed.lastItemAt) {
      const ageDays = Math.max(0, Math.round((Date.now() - feed.lastItemAt) / day));
      if (ageDays > 90) return `Archive — newest item is ${ageDays} days old`;
      if (ageDays > 14) return `Stalled — nothing published in ${ageDays} days`;
    }
    if (feed.lastNewArticleAt) {
      const quietDays = Math.round((Date.now() - feed.lastNewArticleAt) / day);
      if (quietDays > 14) return `Nothing new in ${quietDays} days`;
    }
    return null;
  }

  protected isQuiet(feed: Feed): boolean {
    return this.staleness(feed) !== null;
  }

  /** FR-11: a feed's address is editable, not just its name. */
  protected async editFeed(feed: Feed): Promise<void> {
    const alert = await this.alerts.create({
      header: 'Edit source',
      message: 'A website address works here too — it will find the feed.',
      inputs: [
        { name: 'name', type: 'text', value: feed.sourceName, placeholder: 'Name' },
        { name: 'url', type: 'url', value: feed.url, placeholder: 'Feed or site address' },
      ],
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Save',
          handler: (data: { name: string; url: string }) => {
            void this.saveFeed(feed, data.name, data.url);
          },
        },
      ],
    });
    await alert.present();
  }

  private async saveFeed(feed: Feed, name: string, rawUrl: string): Promise<void> {
    this.finding.set(true);
    try {
      let url = withScheme((rawUrl ?? '').trim());

      // Only go looking if the address changed and is not already a feed.
      if (url && url !== feed.url && !(await this.discovery.validate(url))) {
        const found = await this.discovery.discover(url);
        if (!found.length) {
          await this.toast('No feed found at that address.');
          return;
        }
        url = found[0].url;
      }

      await this.feedService.update(feed.id, { sourceName: name, url });
      await this.reload();
      await this.toast('Saved.');
    } catch (error) {
      await this.toast(error instanceof Error ? error.message : 'Could not save that feed.');
    } finally {
      this.finding.set(false);
    }
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

  protected async setDensity(density: ListDensity): Promise<void> {
    await this.settings.update({ listDensity: density });
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
