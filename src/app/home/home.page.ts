import { Component, OnInit, computed, effect, inject, signal } from '@angular/core';
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
  searchOutline, archiveOutline, closeOutline,
} from 'ionicons/icons';

import { Article, ArticleFilter } from '../core/models';
import { ArticleService } from '../core/article.service';
import { FeedService } from '../core/feed.service';
import { SettingsService } from '../core/settings.service';
import { PollService } from '../core/poll.service';
import { SearchHit, SearchService } from '../core/search.service';
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
  private readonly articles = inject(ArticleService);
  private readonly feeds = inject(FeedService);
  private readonly settings = inject(SettingsService);
  private readonly polls = inject(PollService);
  private readonly search = inject(SearchService);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastController);

  protected readonly items = signal<Article[]>([]);
  protected readonly sources = signal<string[]>([]);
  protected readonly filter = signal<ArticleFilter>({ kind: 'all' });
  protected readonly loading = signal(true);
  protected readonly searching = signal(false);
  protected readonly query = signal('');
  protected readonly hits = signal<SearchHit[]>([]);
  protected readonly searchAvailable = signal(true);
  protected readonly lastRefresh = signal<number | null>(null);

  protected readonly lastRefreshLabel = computed(() => {
    const at = this.lastRefresh();
    return at ? `Updated ${relativeTime(at)}` : 'Not refreshed yet';
  });

  constructor() {
    addIcons({
      settingsOutline, refreshOutline, trashOutline, documentTextOutline,
      searchOutline, archiveOutline, closeOutline,
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
    const parts = [hit.article.sourceName || '', relativeTime(hit.article.publishedAt ?? hit.article.fetchedAt)];
    if (hit.field === 'body') parts.push('in the full text');
    return parts.filter(Boolean).join('  ·  ');
  }

  /** Ionic reuses the page instance, so refresh on every return to it. */
  ionViewWillEnter(): void {
    void this.reload();
  }

  private async reload(): Promise<void> {
    try {
      const [items, sources, lastRefresh] = await Promise.all([
        this.articles.list(this.filter()),
        this.articles.sources(),
        this.settings.lastRefreshAt(),
      ]);
      this.items.set(items);
      this.sources.set(sources);
      this.lastRefresh.set(lastRefresh);
    } catch {
      // A read failure here is not worth a modal; the empty state explains it.
      this.items.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  protected isActive(filter: ArticleFilter): boolean {
    const current = this.filter();
    if (current.kind !== filter.kind) return false;
    if (current.kind === 'source' && filter.kind === 'source') {
      return current.sourceName === filter.sourceName;
    }
    return true;
  }

  protected async setFilter(filter: ArticleFilter): Promise<void> {
    this.filter.set(filter);
    await this.reload();
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

  protected meta(article: Article): string {
    const time = relativeTime(article.publishedAt ?? article.fetchedAt);
    // A shared article has no source until it has been extracted.
    const source = article.sourceName || hostLabel(article.url);
    return [source, time].filter(Boolean).join('  ·  ');
  }

  protected trackById = (_: number, article: Article): number => article.id;
}
