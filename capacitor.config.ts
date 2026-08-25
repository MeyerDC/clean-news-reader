import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.dmeyer.cleannews',
  appName: 'Koppie & Print',
  webDir: 'www',
  android: {
    // The extracted article body is injected as HTML; we never load remote
    // pages in the webview itself (that is what the Custom Tab is for).
    allowMixedContent: false,
  },
  plugins: {
    CapacitorHttp: {
      // FR-4/FR-5: all publisher requests go through the native layer so we
      // are not subject to the webview's CORS rules.
      enabled: true,
    },
    CapacitorSQLite: {
      androidIsEncryption: false,
    },
  },
};

export default config;
