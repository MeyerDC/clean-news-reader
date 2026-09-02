import {
  Component, OnInit, QueryList, ViewChildren, computed, effect, inject, signal,
} from '@angular/core';
import { Router } from '@angular/router';
import {
  IonContent,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonButtons,
  IonButton,
  IonIcon,
  IonList,
  IonItemSliding,
  IonItem,
  IonItemOptions,
  IonItemOption,
  IonRefresher,
  IonRefresherContent,
  IonSpinner,
  ToastController,
} from '@ionic/angular';
import { IonSearchbar } from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  settingsOutline, refreshOutline, trashOutline, documentTextOutline,
  searchOutline, archiveOutline, closeOutline, downloadOutline,
} from 'ionicons/icons';

import { Article, ArticleFilter, Topic } from '../core/models';
import { CuratedPick } from '../core/article.service';
import { ArticleService, DownloadOutcome } from '../core/article.service';
import { TopicService } from '../core/topic.service';
import { FeedService } from '../core/feed.service';
import { SettingsService } from '../core/settings.service';
import { PollService } from '../core/poll.service';
import { SearchHit, SearchService } from '../core/search.service';
import { SplitHeadline, splitHeadline } from '../core/headline';
import { relativeTime } from '../core/time';
import { hostLabel } from '../core/url';

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  imports: [
    IonContent, IonHeader, IonToolbar, IonTitle, IonButtons, IonButton, IonIcon,
    IonList, IonItemSliding, IonItem, IonItemOptions, IonItemOption,
    IonRefresher, IonRefresherContent, IonSpinner, IonSearchbar,
  ],
})
export class HomePage implements OnInit {
  /** The rows themselves, so the first one can demonstrate the swipe. */
  @ViewChildren(IonItemSliding) private rows!: QueryList<IonItemSliding>;

  private readonly articles = inject(ArticleService);
  private readonly feeds = inject(FeedService);
  private readonly settings = inject(SettingsService);
  private readonly polls = inject(PollService);
  private readonly search = inject(SearchService);
  private readonly topics = inject(TopicService);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastController);

  protected readonly items = signal<Article[]>([]);
  /** FR-3: the curated picks, shown above the list on the unfiltered view. */
  protected readonly picks = signal<CuratedPick[]>([]);
  protected readonly curatedAt = signal<number | null>(null);
  protected readonly sources = signal<string[]>([]);
  protected readonly topicList = signal<Topic[]>([]);
  /** Which set of chips the row is showing. Only offered once a topic exists. */
  protected readonly chipMode = signal<'sources' | 'topics'>('sources');
  protected readonly filter = signal<ArticleFilter>({ kind: 'all' });
  protected readonly loading = signal(true);
  protected readonly searching = signal(false);
  protected readonly query = signal('');
  protected readonly hits = signal<SearchHit[]>([]);
  protected readonly searchAvailable = signal(true);
  protected readonly lastRefresh = signal<number | null>(null);
  /** Ids currently being fetched, mapped to how far along they are (0–1). */
  protected readonly downloading = signal<Map<number, number>>(new Map());

  /** FR-9 density: how much room one article gets. Applied as a class so the
      list, the search results and the empty states all move together. */
  protected readonly density = computed(() => this.settings.settings().listDensity);

  protected readonly lastRefreshLabel = computed(() => {
    const at = this.lastRefresh();
    return at ? `Updated ${relativeTime(at)}` : 'Not refreshed yet';
  });

  constructor() {
    addIcons({
      settingsOutline, refreshOutline, trashOutline, documentTextOutline,
      searchOutline, archiveOutline, closeOutline, downloadOutline,
    });

    // Re-read the list whenever the article table changes in-app, and whenever
    // the background job finishes writing to it.
    effect(() => {
      this.articles.revision();
      this.polls.completed();
      void this.reload();
    });
  }

  async ngOnInit(): Promise<void> {
    this.searchAvailable.set(this.search.available);
    await this.reload();
    await this.showDownloadHint();
  }

  /**
   * A swipe nobody is told about is the same as no feature. Once, on the first
   * list that has anything in it, the top row opens far enough to show the
   * download button and closes again.
   *
   * Marked as seen before it runs: a hint that reappears because the animation
   * was interrupted is worse than one that is missed.
   */
  private async showDownloadHint(): Promise<void> {
    if (!this.items().length) return;
    if (await this.settings.downloadHintSeen()) return;

    // The rows exist as data before they exist as components, so the query is
    // empty for a frame or two after the list loads.
    const first = await this.firstRow();
    if (!first) return;

    // Marked only once there is a row to demonstrate on, and before the
    // animation rather than after: a hint that replays because it was
    // interrupted is worse than one that is missed.
    await this.settings.markDownloadHintSeen();

    await first.open('start');
    await new Promise((resolve) => setTimeout(resolve, 1600));
    await first.close();
  }

  private async firstRow(): Promise<IonItemSliding | null> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const row = this.rows?.first;
      if (row) return row;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }

  // ---- search ------------------------------------------------------------

  /**
   * Runs on every keystroke. FTS5 over this corpus answers in well under a
   * frame, so there is nothing to gain from debouncing and a real cost in
   * feeling laggy.
   */
  protected async onSearch(value: string): Promise<void> {
    this.query.set(value);

    if (!value.trim()) {
      this.hits.set([]);
      this.searching.set(false);
      return;
    }

    this.searching.set(true);
    try {
      this.hits.set(await this.search.search(value));
    } catch {
      this.hits.set([]);
    }
  }

  protected clearSearch(): void {
    this.query.set('');
    this.hits.set([]);
    this.searching.set(false);
  }

  protected get isSearching(): boolean {
    return this.query().trim().length > 0;
  }

  /** FR-5's images are gone for an archived article; say so rather than imply it. */
  protected hitMeta(hit: SearchHit): string {
    // Same fallback the list uses: an article with no publisher still shows
    // where it came from rather than a blank.
    const parts = [
      hit.article.sourceName || hostLabel(hit.article.url),
      relativeTime(hit.article.publishedAt ?? hit.article.fetchedAt),
    ];
    if (hit.field === 'body') parts.push('in the full text');
    return parts.filter(Boolean).join('  ·  ');
  }

  /** Ionic reuses the page instance, so refresh on every return to it. */
  ionViewWillEnter(): void {
    void this.reload();
  }

  private async reload(): Promise<void> {
    try {
      const [items, sources, topics, lastRefresh, picks, curatedAt] = await Promise.all([
        // History is a record that only grows, so it gets a far larger window
        // than the browsing list. It is still a window: a few years of reading
        // is thousands of rows, and this list is not virtualised. Search
        // already reaches the whole archive, including rows older than this.
        this.articles.list(this.filter(), this.filter().kind === 'read' ? 1000 : 200),
        this.articles.sources(),
        this.topics.list(),
        this.settings.lastRefreshAt(),
        this.articles.curated(),
        this.articles.curatedAt(),
      ]);
      this.picks.set(picks);
      this.curatedAt.set(curatedAt);

      // A pick shown above must not appear again below: the same headline twice
      // on one screen reads as a bug, and it wastes the room the section was
      // given. Only the picks actually on screen are removed — if the section
      // is hidden, or a filter is on, the list is the whole list again. The
      // widget applies the same rule for the same reason.
      const shown = this.showPicks() ? new Set(picks.map((p) => p.article.id)) : null;
      this.items.set(shown ? items.filter((a) => !shown.has(a.id)) : items);
      this.sources.set(sources);
      this.topicList.set(topics);
      this.lastRefresh.set(lastRefresh);

      // A topic deleted in settings must not leave the list pinned to a filter
      // that can no longer match anything.
      const current = this.filter();
      if (current.kind === 'topic' && !topics.some((t) => t.id === current.topicId)) {
        await this.setFilter({ kind: 'all' });
      }
    } catch {
      // A read failure here is not worth a modal; the empty state explains it.
      this.items.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Shown only on the unfiltered list. Inside "Saved" or a topic the reader has
   * asked a specific question, and answering it with ten articles chosen on
   * other grounds would be a category error.
   */
  /** Says when the picks were chosen, so a list that has not moved reads as
      deliberate rather than stuck. */
  protected picksLabel(): string {
    const at = this.curatedAt();
    if (!at) return '';
    const mins = Math.round((Date.now() - at) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
  }

  protected showPicks(): boolean {
    return (
      this.settings.settings().curatedEnabled &&
      this.filter().kind === 'all' &&
      !this.searching() &&
      this.picks().length > 0
    );
  }

  protected isActive(filter: ArticleFilter): boolean {
    const current = this.filter();
    if (current.kind !== filter.kind) return false;
    if (current.kind === 'source' && filter.kind === 'source') {
      return current.sourceName === filter.sourceName;
    }
    if (current.kind === 'topic' && filter.kind === 'topic') {
      return current.topicId === filter.topicId;
    }
    return true;
  }

  protected async setFilter(filter: ArticleFilter): Promise<void> {
    this.filter.set(filter);
    await this.reload();
  }

  /**
   * Switching the chip row is a view change, not a filter change — but leaving
   * a source filter applied while showing topic chips would look broken, so an
   * active chip from the other set is dropped.
   */
  protected async setChipMode(mode: 'sources' | 'topics'): Promise<void> {
    this.chipMode.set(mode);
    const current = this.filter();
    if (
      (mode === 'topics' && current.kind === 'source') ||
      (mode === 'sources' && current.kind === 'topic')
    ) {
      await this.setFilter({ kind: 'all' });
    }
  }

  /** FR-9: pull to refresh triggers an immediate poll. */
  protected async refresh(event: CustomEvent): Promise<void> {
    try {
      // Resolves on the job's real completion event, not a guessed delay.
      await this.feeds.refreshNow();
      await this.reload();
    } finally {
      (event.target as HTMLIonRefresherElement | null)?.complete();
    }
  }

  protected open(article: Article): void {
    void this.router.navigate(['/article', article.id]);
  }

  /**
   * Fetches an article before it is opened, for reading with no connection.
   * The work is the same as opening it — extract, then cache the images — and
   * the download is kept, so retention will not sweep it away before the
   * flight it was downloaded for.
   */
  protected async download(article: Article, sliding: IonItemSliding): Promise<void> {
    await sliding.close();
    if (this.downloading().has(article.id)) return;

    const setProgress = (fraction: number) =>
      this.downloading.update((all) => new Map(all).set(article.id, fraction));

    setProgress(0);
    try {
      const outcome = await this.articles.download(article.id, setProgress);
      await this.toast(downloadMessage(outcome, article.title));
    } catch {
      await this.toast('Could not download that article.');
    } finally {
      this.downloading.update((all) => {
        const next = new Map(all);
        next.delete(article.id);
        return next;
      });
      await this.reload();
    }
  }

  private async toast(message: string): Promise<void> {
    const toast = await this.toasts.create({ message, duration: 2600, position: 'bottom' });
    await toast.present();
  }

  /** FR-9: swipe to dismiss an article from the list. */
  protected async dismiss(article: Article, sliding: IonItemSliding): Promise<void> {
    await sliding.close();
    await this.articles.dismiss(article.id);

    const toast = await this.toasts.create({
      message: 'Dismissed',
      duration: 3000,
      position: 'bottom',
      buttons: [
        {
          text: 'Undo',
          handler: () => {
            void this.articles.undismiss(article.id);
          },
        },
      ],
    });
    await toast.present();
  }

  protected openSettings(): void {
    void this.router.navigate(['/settings']);
  }

  /**
   * Memoised because the template asks twice per row and change detection asks
   * again on every pass. The key is the title itself, so a row that scrolls
   * away and back costs nothing.
   */
  private readonly headlines = new Map<string, SplitHeadline>();

  protected split(title: string): SplitHeadline {
    let cached = this.headlines.get(title);
    if (!cached) {
      if (this.headlines.size > 2000) this.headlines.clear();
      cached = splitHeadline(title);
      this.headlines.set(title, cached);
    }
    return cached;
  }

  protected meta(article: Article): string {
    const time = relativeTime(article.publishedAt ?? article.fetchedAt);
    // A shared article has no source until it has been extracted.
    const source = article.sourceName || hostLabel(article.url);
    return [source, time].filter(Boolean).join('  ·  ');
  }

  protected trackById = (_: number, article: Article): number => article.id;
}

/**
 * Says what actually happened. A download that skipped every image because the
 * user asked not to fetch pictures on mobile data is a success, but claiming
 * "saved for offline" without saying so would be a promise the reader breaks
 * later, in a tunnel, when the pictures are missing.
 */
export function downloadMessage(outcome: DownloadOutcome, title: string): string {
  switch (outcome.state) {
    case 'ok':
      return outcome.images === 'cached'
        ? 'Saved for offline.'
        : 'Text saved. Images wait for Wi-Fi.';
    case 'offline':
      return 'No connection — nothing to download from.';
    default:
      return outcome.reason === 'paywall'
        ? `${title} is paywalled.`
        : 'That article could not be downloaded.';
  }
}
