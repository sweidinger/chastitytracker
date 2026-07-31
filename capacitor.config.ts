import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "ch.chastitytracker.app",
  appName: "ChastityTracker",
  webDir: "www",
  server: {
    // Allow the WebView to navigate to any of the three base domains.
    // After the user enters their instance URL in the shell, the WebView
    // follows the redirect and the Capacitor bridge remains active.
    allowNavigation: [
      "*.trublue.ch",
      "*.chastitytracker.ch",
      "*.chastity-tracker.com",
      // Lokaler Beta-/Prod-Server (selbstsigniertes HTTPS) für On-Device-Tests im LAN.
      "10.0.1.9",
    ],
    androidScheme: "https",
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"],
    },
  },
};

export default config;
