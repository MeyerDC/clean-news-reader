import { Component, inject } from '@angular/core';
import { IonApp, IonRouterOutlet } from '@ionic/angular';

import { BootstrapService } from './core/bootstrap.service';

@Component({
  selector: 'app-root',
  templateUrl: 'app.component.html',
  styleUrls: ['app.component.scss'],
  imports: [IonApp, IonRouterOutlet],
})
export class AppComponent {
  protected readonly bootstrap = inject(BootstrapService);
}
