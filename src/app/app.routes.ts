import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('./home/home.page').then((m) => m.HomePage),
  },
  {
    // FR-3 and FR-8 both land here directly rather than on the list.
    path: 'article/:id',
    loadComponent: () => import('./reader/reader.page').then((m) => m.ReaderPage),
  },
  {
    // 'new' creates one; an id edits it.
    path: 'topics/:id',
    loadComponent: () => import('./topic/topic.page').then((m) => m.TopicPage),
  },
  {
    path: 'settings',
    loadComponent: () => import('./settings/settings.page').then((m) => m.SettingsPage),
  },
  { path: '**', redirectTo: '' },
];
