import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { App } from '@capacitor/app';
import { ToastController } from '@ionic/angular';

import { CleanNews, NativeRoute } from './clean-news.plugin';
import { ArticleService } from './article.service';

/**
 * Turns native intents into navigation.
 *
 * FR-3 and FR-8 both demand landing on the reader rather than the home screen,
 * so this runs before the first route is shown and again for every intent that
 * arrives while the app is already open.
 */
@Injectable({ providedIn: 'root' })
export class IntentService {
  private started = false;

  private readonly router = inject(Router);
  private readonly articles = inject(ArticleService);
  private readonly toasts = inject(ToastController);

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    await CleanNews.addListener('appIntent', (route) => {
      void this.handle(route);
    });

    // Drain whatever launched us. Anything parked before the webview existed
    // is waiting here.
    const { route } = await CleanNews.consumePendingIntent();
    if (route) await this.handle(route);
  }

  private async handle(route: NativeRoute): Promise<void> {
    switch (route.type) {
      case 'article':
        // FR-3: straight into the reader for that article.
        await this.router.navigate(['/article', route.articleId], { replaceUrl: true });
        break;

      case 'share':
        await this.openShared(route.url);
        break;

      case 'shareNoUrl':
        // FR-8: no URL in the shared text — brief error, then close.
        await this.showError('That share did not contain a link.');
        await App.exitApp().catch(() => undefined);
        break;
    }
  }

  private async openShared(url: string): Promise<void> {
    try {
      const article = await this.articles.createFromSharedUrl(url);
      // Extraction starts inside the reader, which shows the loading state.
      await this.router.navigate(['/article', article.id], { replaceUrl: true });
    } catch (error) {
      await this.showError(error instanceof Error ? error.message : 'Could not open that link.');
      await App.exitApp().catch(() => undefined);
    }
  }

  private async showError(message: string): Promise<void> {
    const toast = await this.toasts.create({ message, duration: 2200, position: 'bottom' });
    await toast.present();
    // Let the toast be read before the app goes away.
    await new Promise((resolve) => setTimeout(resolve, 2200));
  }
}
