import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Browser } from '@capacitor/browser';
import { Clipboard } from '@capacitor/clipboard';
import {
  IonContent,
  IonHeader,
  IonToolbar,
  IonButtons,
  IonButton,
  IonIcon,
  IonBackButton,
  IonSpinner,
  ActionSheetController,
  ToastController,
  AlertController,
} from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  ellipsisVertical,
  openOutline,
  refreshOutline,
  cloudOfflineOutline,
  lockClosedOutline,
  textOutline,
  closeOutline,
  playCircleOutline,
} from 'ionicons/icons';

import { Article } from '../core/models';
import { ArticleService, ExtractionOutcome } from '../core/article.service';
import { ExtractionService } from '../core/extraction.service';
import { ImageCacheService, ReadyImage } from '../core/image-cache.service';
import { SettingsService, FONT_SIZE_MAX, FONT_SIZE_MIN } from '../core/settings.service';
import { DiscoveredFeed, FeedDiscoveryService, describeFeed } from '../core/feed-discovery.service';
import { FeedService } from '../core/feed.service';
import { formatDate, readingTime, relativeTime } from '../core/time';
import { hostLabel } from '../core/url';

type ViewState = 'loading' | 'ready' | 'failed' | 'offline' | 'missing';

/** FR-9: the reader must be open this long before the article counts as read. */
const READ_AFTER_MS = 5000;

@Component({
  selector: 'app-reader',
  templateUrl: 'reader.page.html',
  styleUrls: ['reader.page.scss'],
  imports: [
    IonContent, IonHeader, IonToolbar, IonButtons, IonButton, IonIcon,
    IonBackButton, IonSpinner,
  ],
})
export class ReaderPage implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly articles = inject(ArticleService);
  private readonly extraction = inject(ExtractionService);
  private readonly images = inject(ImageCacheService);
  private readonly settings = inject(SettingsService);
  private readonly actionSheets = inject(ActionSheetController);
  private readonly toasts = inject(ToastController);
  private readonly alerts = inject(AlertController);
  private readonly discovery = inject(FeedDiscoveryService);
  private readonly feeds = inject(FeedService);

  @ViewChild(IonContent) private content?: IonContent;
  @ViewChild('body') private bodyRef?: ElementRef<HTMLElement>;

  protected readonly article = signal<Article | null>(null);
  protected readonly state = signal<ViewState>('loading');
  protected readonly failure = signal<{
    reason: 'paywall' | 'other' | 'video';
    detail: string;
  } | null>(null);
  protected readonly leadImageSrc = signal<string | null>(null);
  /** FR-6: estimated read time, known only once the body has been prepared. */
  protected readonly readTimeLabel = signal<string | null>(null);
  /** Feeds found for a shared article from a site you don't already follow. */
  protected readonly followOffer = signal<DiscoveredFeed[] | null>(null);
  protected readonly following = signal(false);
  protected readonly fontSize = computed(() => this.settings.settings().fontSize);

  protected readonly byline = computed(() => {
    const article = this.article();
    if (!article) return '';
    return [
      article.sourceName || hostLabel(article.url),
      article.author,
      formatDate(article.publishedAt) || relativeTime(article.fetchedAt),
      this.readTimeLabel(),
    ]
      .filter(Boolean)
      .join('  ·  ');
  });

  private readTimer?: ReturnType<typeof setTimeout>;
  private scrollSaveTimer?: ReturnType<typeof setTimeout>;
  private articleId = 0;
  private destroyed = false;

  constructor() {
    addIcons({
      ellipsisVertical, openOutline, refreshOutline,
      cloudOfflineOutline, lockClosedOutline, textOutline, closeOutline,
      playCircleOutline,
    });
  }

  async ngOnInit(): Promise<void> {
    this.articleId = Number(this.route.snapshot.paramMap.get('id'));
    if (!this.articleId) {
      this.state.set('missing');
      return;
    }
    await this.load();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    clearTimeout(this.readTimer);
    clearTimeout(this.scrollSaveTimer);
    void this.persistScroll();
  }

  ionViewWillLeave(): void {
    void this.persistScroll();
  }

  private async load(force = false): Promise<void> {
    this.state.set('loading');
    this.failure.set(null);

    const article = await this.articles.get(this.articleId);
    if (!article) {
      this.state.set('missing');
      return;
    }
    this.article.set(article);

    // FR-8: a shared link arrives with nothing extracted, and this is where
    // the loading state the user sees comes from.
    const outcome: ExtractionOutcome = await this.articles.ensureExtracted(this.articleId, force);
    if (this.destroyed) return;

    if (outcome.state === 'offline') {
      this.state.set('offline');
      return;
    }
    if (outcome.state === 'failed') {
      // FR-7: no blank reader — an explanation and a way to the original page.
      this.failure.set({ reason: outcome.reason, detail: outcome.detail });
      this.state.set('failed');
      return;
    }

    const fresh = await this.articles.get(this.articleId);
    if (!fresh?.bodyHtml) {
      this.failure.set({ reason: 'other', detail: 'There was nothing to read on this page.' });
      this.state.set('failed');
      return;
    }

    this.article.set(fresh);
    this.state.set('ready');

    // The template only creates the body container once state is 'ready'.
    setTimeout(() => void this.renderBody(fresh), 0);
    this.startReadTimer();

    // Not awaited: the offer is a quiet footnote, never something the article
    // waits for.
    void this.offerFeedIfNew(fresh);
  }

  // ---- rendering --------------------------------------------------------

  /**
   * Builds the body as real DOM rather than binding a string, so images can be
   * swapped in as they download without re-rendering the article around them
   * (failure-mode table: a very long article must not block on its images).
   */
  private async renderBody(article: Article): Promise<void> {
    const host = this.bodyRef?.nativeElement;
    if (!host || !article.bodyHtml) return;

    // Every stored body goes through the sanitiser again, including bodies
    // that came straight from a feed and never saw extract() (FR-1).
    const prepared = this.extraction.cleanBody(article.bodyHtml, article.url, article.author);
    this.readTimeLabel.set(readingTime(prepared.text));

    const cached = await this.images.cachedFor(article.id);
    if (this.destroyed) return;

    // Publishers usually repeat the lead image as the first figure in the
    // body. Showing it twice looks like a bug, so the body copy goes.
    const leadRemoteUrl = article.leadImagePath
      ? await this.articles.leadImageRemoteUrl(article.id)
      : null;
    let leadDuplicateDropped = false;

    const fragment = document
      .createRange()
      .createContextualFragment(prepared.html);

    const pending: { url: string; caption: string | null }[] = [];

    fragment.querySelectorAll('img').forEach((img) => {
      const remoteUrl = img.getAttribute('src');
      if (!remoteUrl) {
        img.remove();
        return;
      }
      if (!leadDuplicateDropped && remoteUrl === leadRemoteUrl) {
        leadDuplicateDropped = true;
        (img.closest('figure') ?? img).remove();
        return;
      }

      const caption = img.getAttribute('data-caption');
      const ready = cached.get(remoteUrl);

      const figure = this.buildFigure(remoteUrl, caption, ready);

      // FR-5: inline images render at their original position in the body.
      const anchor = img.closest('figure') ?? img;
      anchor.parentNode?.replaceChild(figure, anchor);

      if (!ready) pending.push({ url: remoteUrl, caption });
    });

    host.replaceChildren(fragment);

    // Lead image first (FR-5), then restore where the reader left off (FR-6).
    await this.renderLeadImage(article);
    await this.restoreScroll(article);

    // An archived article is a text record: its images were released when it
    // aged out of the cache, and re-downloading them here would quietly undo
    // that and leave files nothing will clean up again.
    if (article.isArchived) {
      this.dropFailedImages(host);
      return;
    }

    // Images stream in behind the text that is already on screen.
    if (pending.length) {
      await this.images.cacheAll(article.id, pending, (image) => this.applyImage(image));
      if (!this.destroyed) this.dropFailedImages(host);
    }
  }

  /**
   * FR-5: a frame that already holds the right aspect ratio, so nothing shifts
   * under the reader's eyes when the file arrives.
   */
  private buildFigure(
    remoteUrl: string,
    caption: string | null,
    ready: ReadyImage | undefined,
  ): HTMLElement {
    const figure = document.createElement('figure');
    figure.className = 'cn-figure';
    figure.setAttribute('data-cn-src', remoteUrl);

    const frame = document.createElement('div');
    frame.className = 'cn-figure-frame';

    const width = ready?.width;
    const height = ready?.height;
    if (width && height) {
      frame.style.setProperty('--cn-ratio', `${width} / ${height}`);
    }

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = caption ?? '';
    img.addEventListener('load', () => img.classList.add('cn-loaded'), { once: true });
    // FR-5: a broken file is removed rather than shown as a broken icon.
    img.addEventListener('error', () => figure.remove(), { once: true });

    if (ready) {
      img.src = ready.src;
    } else {
      figure.classList.add('cn-figure-pending');
    }

    frame.appendChild(img);
    figure.appendChild(frame);

    if (caption) {
      const figcaption = document.createElement('figcaption');
      figcaption.textContent = caption;
      figure.appendChild(figcaption);
    }

    return figure;
  }

  /** Called as each download lands. */
  private applyImage(image: ReadyImage): void {
    const host = this.bodyRef?.nativeElement;
    if (!host || this.destroyed) return;

    const figure = host.querySelector<HTMLElement>(
      `figure[data-cn-src="${cssEscape(image.remoteUrl)}"]`,
    );
    if (!figure) return;

    const frame = figure.querySelector<HTMLElement>('.cn-figure-frame');
    if (image.width && image.height) {
      frame?.style.setProperty('--cn-ratio', `${image.width} / ${image.height}`);
    }

    const img = figure.querySelector('img');
    if (img) img.src = image.src;
    figure.classList.remove('cn-figure-pending');
  }

  /** Anything still without a file could not be fetched; FR-5 removes it. */
  private dropFailedImages(host: HTMLElement): void {
    host.querySelectorAll('.cn-figure-pending').forEach((figure) => figure.remove());
  }

  private async renderLeadImage(article: Article): Promise<void> {
    if (!article.leadImagePath) return;
    const src = await this.images.toWebviewSrc(article.leadImagePath);
    if (!this.destroyed) this.leadImageSrc.set(src);
  }

  // ---- following a shared article's site -------------------------------

  /**
   * A shared article from a site you don't follow is the natural moment to
   * offer its feed — it is the one point where we know you liked the source
   * enough to read it.
   *
   * Only shared articles qualify: an article that arrived through a feed is by
   * definition from a site you already follow.
   */
  private async offerFeedIfNew(article: Article): Promise<void> {
    if (article.feedId !== null) return;

    try {
      if (await this.feeds.isFollowing(article.url)) return;

      // The page was already downloaded to extract this article, so a declared
      // feed costs nothing to find. Probing only happens if none is declared.
      const found = await this.discovery.discover(article.url);
      if (found.length && !this.destroyed) this.followOffer.set(found);
    } catch {
      // Discovery is a convenience; failing it should be invisible.
    }
  }

  protected async follow(feed: DiscoveredFeed): Promise<void> {
    this.following.set(true);
    try {
      await this.feeds.addDiscovered(feed);
      this.followOffer.set(null);
      await this.toast(`Following ${feed.title}`);
    } catch (error) {
      await this.toast(error instanceof Error ? error.message : 'Could not add that feed.');
    } finally {
      this.following.set(false);
    }
  }

  /** Lets you pick when a site publishes several feeds. */
  protected async chooseFeed(): Promise<void> {
    const options = this.followOffer();
    if (!options?.length) return;

    const sheet = await this.actionSheets.create({
      header: 'Which feed?',
      buttons: [
        ...options.map((feed) => ({
          text: `${feed.title} · ${describeFeed(feed)}`,
          handler: () => {
            void this.follow(feed);
          },
        })),
        { text: 'Cancel', role: 'cancel' as const },
      ],
    });
    await sheet.present();
  }

  /** Same wording as the settings picker, so the two agree. */
  protected describe(feed: DiscoveredFeed): string {
    return describeFeed(feed);
  }

  protected dismissOffer(): void {
    this.followOffer.set(null);
  }

  // ---- read state and scroll -------------------------------------------

  private startReadTimer(): void {
    clearTimeout(this.readTimer);
    this.readTimer = setTimeout(() => {
      void this.articles.markRead(this.articleId);
    }, READ_AFTER_MS);
  }

  /** FR-6: reopening an article returns to where the user stopped. */
  private async restoreScroll(article: Article): Promise<void> {
    if (!article.scrollPosition || !this.content) return;
    // One frame for layout, so the target offset actually exists.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await this.content.scrollToPoint(0, article.scrollPosition, 0);
  }

  protected onScroll(event: CustomEvent<{ scrollTop: number }>): void {
    const top = event.detail?.scrollTop ?? 0;
    clearTimeout(this.scrollSaveTimer);
    // Writing on every scroll frame would hammer the database.
    this.scrollSaveTimer = setTimeout(() => {
      void this.articles.saveScrollPosition(this.articleId, top);
    }, 400);
  }

  private async persistScroll(): Promise<void> {
    if (!this.content || !this.articleId) return;
    try {
      const element = await this.content.getScrollElement();
      await this.articles.saveScrollPosition(this.articleId, element.scrollTop);
    } catch {
      // The page may already be torn down; the throttled save covers us.
    }
  }

  // ---- actions ----------------------------------------------------------

  /** FR-7: always available, whatever the extraction outcome. Uses a Custom Tab. */
  protected async openOriginal(): Promise<void> {
    const article = this.article();
    if (!article) return;
    await Browser.open({ url: article.url, presentationStyle: 'popover' });
  }

  /** FR-7: manual retry — failures are never retried automatically. */
  protected async tryAgain(): Promise<void> {
    await this.load(true);
  }

  protected async openMenu(): Promise<void> {
    const article = this.article();
    if (!article) return;

    const sheet = await this.actionSheets.create({
      buttons: [
        {
          text: 'Open original page',
          icon: 'open-outline',
          handler: () => {
            void this.openOriginal();
          },
        },
        {
          text: 'Copy link',
          handler: () => {
            void this.copyLink();
          },
        },
        {
          text: article.isSaved ? 'Remove from saved' : 'Save article',
          handler: () => {
            void this.toggleSaved();
          },
        },
        {
          text: 'Delete from cache',
          role: 'destructive',
          handler: () => {
            void this.confirmDelete();
          },
        },
        { text: 'Cancel', role: 'cancel' },
      ],
    });
    await sheet.present();
  }

  protected async cycleFontSize(): Promise<void> {
    const current = this.settings.settings().fontSize;
    // A single control that steps up and wraps round is quicker to reach on a
    // phone than a slider you have to aim at while reading.
    const next = current >= FONT_SIZE_MAX ? FONT_SIZE_MIN : current + 2;
    await this.settings.update({ fontSize: next });
  }

  private async copyLink(): Promise<void> {
    const article = this.article();
    if (!article) return;
    await Clipboard.write({ url: article.url });
    await this.toast('Link copied');
  }

  private async toggleSaved(): Promise<void> {
    const article = this.article();
    if (!article) return;
    await this.articles.setSaved(article.id, !article.isSaved);
    this.article.set({ ...article, isSaved: !article.isSaved });
    await this.toast(article.isSaved ? 'Removed from saved' : 'Saved');
  }

  private async confirmDelete(): Promise<void> {
    const alert = await this.alerts.create({
      header: 'Delete from cache?',
      message: 'The article and its images are removed from this device.',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Delete',
          role: 'destructive',
          handler: () => {
            void this.deleteArticle();
          },
        },
      ],
    });
    await alert.present();
  }

  private async deleteArticle(): Promise<void> {
    await this.articles.deleteFromCache(this.articleId);
    await this.router.navigate(['/'], { replaceUrl: true });
  }

  private async toast(message: string): Promise<void> {
    const toast = await this.toasts.create({ message, duration: 1600, position: 'bottom' });
    await toast.present();
  }

  /** FR-7: each failure names the actual problem rather than shrugging. */
  protected get failureTitle(): string {
    switch (this.failure()?.reason) {
      case 'paywall':
        return 'This one is behind a paywall';
      case 'video':
        return 'This one is a video';
      default:
        return "Couldn't read this one cleanly";
    }
  }

  protected get failureIcon(): string {
    switch (this.failure()?.reason) {
      case 'paywall':
        return 'lock-closed-outline';
      case 'video':
        return 'play-circle-outline';
      default:
        return 'open-outline';
    }
  }

  /** "Watch on TimesLIVE" reads better than "open original page" for a video. */
  protected get primaryActionLabel(): string {
    if (this.failure()?.reason !== 'video') return 'Open original page';
    const source = this.article()?.sourceName;
    return source ? `Watch on ${source}` : 'Watch on the original page';
  }

  /**
   * The body may contain a marker where a video embed was. Tapping it goes to
   * the same place the overflow menu does — the publisher's own player.
   */
  protected onBodyTap(event: Event): void {
    const target = event.target as HTMLElement | null;
    if (target?.closest('[data-cn-video]')) {
      event.preventDefault();
      void this.openOriginal();
    }
  }
}

/** CSS.escape is not everywhere; the URLs we key on only need quotes escaped. */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
