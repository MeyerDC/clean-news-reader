import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import {
  IonContent, IonHeader, IonToolbar, IonTitle, IonButtons, IonBackButton,
  IonButton, IonIcon, IonList, IonListHeader, IonItem, IonLabel, IonInput,
  IonCheckbox, IonNote, AlertController, ToastController,
} from '@ionic/angular';
import { addIcons } from 'ionicons';
import { trashOutline } from 'ionicons/icons';

import { Feed, Topic } from '../core/models';

/** How many categories to show before the "show all" link. */
const CATEGORY_PREVIEW = 12;
import { FeedService } from '../core/feed.service';
import { TopicService } from '../core/topic.service';

@Component({
  selector: 'app-topic',
  templateUrl: 'topic.page.html',
  styleUrls: ['topic.page.scss'],
  imports: [
    FormsModule, IonContent, IonHeader, IonToolbar, IonTitle, IonButtons,
    IonBackButton, IonButton, IonIcon, IonList, IonListHeader, IonItem,
    IonLabel, IonInput, IonCheckbox, IonNote,
  ],
})
export class TopicPage implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly topics = inject(TopicService);
  private readonly feedService = inject(FeedService);
  private readonly alerts = inject(AlertController);
  private readonly toasts = inject(ToastController);

  protected readonly name = signal('');
  protected readonly feedIds = signal<number[]>([]);
  protected readonly categories = signal<string[]>([]);
  protected readonly keywordText = signal('');

  protected readonly feeds = signal<Feed[]>([]);
  protected readonly knownCategories = signal<{ name: string; articles: number }[]>([]);
  protected readonly showAllCategories = signal(false);

  /**
   * A few hundred articles produce a long tail of categories, most of them
   * one-offs, and burying the keyword field under all of them makes the last
   * rule the hardest to reach. The busiest ones are shown; a ticked category
   * always stays visible so an edit never appears to lose it.
   */
  protected readonly visibleCategories = computed(() => {
    const all = this.knownCategories();
    if (this.showAllCategories() || all.length <= CATEGORY_PREVIEW) return all;
    const chosen = new Set(this.categories());
    const top = all.slice(0, CATEGORY_PREVIEW);
    return [...top, ...all.slice(CATEGORY_PREVIEW).filter((c) => chosen.has(c.name))];
  });

  protected readonly hiddenCategoryCount = computed(
    () => this.knownCategories().length - this.visibleCategories().length,
  );

  /** The live preview: what this rule catches, right now. */
  protected readonly matchCount = signal<number | null>(null);
  protected readonly samples = signal<string[]>([]);

  protected readonly isNew = computed(() => this.topicId === null);

  private topicId: number | null = null;

  constructor() {
    addIcons({ trashOutline });
  }

  async ngOnInit(): Promise<void> {
    const param = this.route.snapshot.paramMap.get('id');
    this.topicId = param && param !== 'new' ? Number(param) : null;

    const [feeds, categories] = await Promise.all([
      this.feedService.list(),
      this.topics.knownCategories(),
    ]);
    this.feeds.set(feeds);
    this.knownCategories.set(categories);

    if (this.topicId) {
      const topic = await this.topics.get(this.topicId);
      if (topic) {
        this.name.set(topic.name);
        this.feedIds.set(topic.feedIds);
        this.categories.set(topic.categories);
        this.keywordText.set(topic.keywords.join(', '));
      }
    }
    await this.preview();
  }

  private draft(): Topic {
    return {
      id: this.topicId ?? 0,
      name: this.name(),
      sortOrder: 0,
      feedIds: this.feedIds(),
      categories: this.categories(),
      keywords: this.keywordText().split(',').map((k) => k.trim()).filter(Boolean),
    };
  }

  /**
   * Recomputed on every change. Tuning a fuzzy keyword rule blind would be
   * miserable, so the rule shows its own results while you edit it.
   */
  protected async preview(): Promise<void> {
    const draft = this.draft();

    // A topic with no rules matches nothing, but "Matches 0 articles" reads
    // as a rule that failed rather than one not written yet.
    if (!this.topics.buildClause(draft)) {
      this.matchCount.set(null);
      this.samples.set([]);
      return;
    }

    try {
      const [count, samples] = await Promise.all([
        this.topics.countMatches(draft),
        this.topics.sampleMatches(draft),
      ]);
      this.matchCount.set(count);
      this.samples.set(samples);
    } catch {
      this.matchCount.set(null);
      this.samples.set([]);
    }
  }

  protected toggleFeed(feedId: number, on: boolean): void {
    this.feedIds.update((ids) =>
      on ? [...new Set([...ids, feedId])] : ids.filter((id) => id !== feedId),
    );
    void this.preview();
  }

  protected toggleCategory(name: string, on: boolean): void {
    this.categories.update((all) =>
      on ? [...new Set([...all, name])] : all.filter((c) => c !== name),
    );
    void this.preview();
  }

  protected hasFeed(feedId: number): boolean {
    return this.feedIds().includes(feedId);
  }

  protected hasCategory(name: string): boolean {
    return this.categories().includes(name);
  }

  protected async save(): Promise<void> {
    try {
      await this.topics.save({
        id: this.topicId ?? undefined,
        name: this.name(),
        feedIds: this.feedIds(),
        categories: this.categories(),
        keywords: this.draft().keywords,
      });
      await this.router.navigate(['/settings'], { replaceUrl: true });
    } catch (error) {
      const toast = await this.toasts.create({
        message: error instanceof Error ? error.message : 'Could not save that topic.',
        duration: 2200,
      });
      await toast.present();
    }
  }

  protected async remove(): Promise<void> {
    if (!this.topicId) return;
    const alert = await this.alerts.create({
      header: `Delete ${this.name()}?`,
      message: 'The topic goes; your articles stay.',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Delete',
          role: 'destructive',
          handler: () => {
            void this.doRemove();
          },
        },
      ],
    });
    await alert.present();
  }

  private async doRemove(): Promise<void> {
    if (this.topicId) await this.topics.remove(this.topicId);
    await this.router.navigate(['/settings'], { replaceUrl: true });
  }
}
