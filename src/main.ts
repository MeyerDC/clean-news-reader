import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideAppInitializer, inject } from '@angular/core';
import { RouteReuseStrategy } from '@angular/router';
import { IonicRouteStrategy, provideIonicAngular } from '@ionic/angular';

import { AppComponent } from './app/app.component';
import { routes } from './app/app.routes';
import { BootstrapService } from './app/core/bootstrap.service';

bootstrapApplication(AppComponent, {
  providers: [
    { provide: RouteReuseStrategy, useClass: IonicRouteStrategy },
    provideIonicAngular({ mode: 'md' }),
    provideRouter(routes, withComponentInputBinding()),
    // Opens the database, loads settings and applies the theme before the
    // first screen paints, so nothing flashes the wrong colours.
    provideAppInitializer(() => inject(BootstrapService).run()),
  ],
}).catch((err) => console.error(err));
