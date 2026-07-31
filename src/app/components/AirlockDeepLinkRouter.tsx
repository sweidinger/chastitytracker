"use client";

import { useEffect } from "react";
import { isNativePlatform } from "@/lib/nativePush";

const TAG_HOST = "nfc.neurorelatepoly.app";

/**
 * Öffnet beim Antippen eines Airlock-Tags (Universal Link) die passende Kontroll-Anforderung
 * INNERHALB der App. Spiegelt das Muster von NativePushRouter: nativer Event → same-origin-Navigation.
 * Die eigentliche Auflösung Code → Lock → offene Kontrolle macht der Server (/airlock/open), damit
 * kein Prisma-/Server-Modul in den Client gezogen wird (Client/Server-Grenze, vgl. CLAUDE.md).
 *
 * Zwei Fälle: Warm-Start (App läuft) = Event `appUrlOpen`; Kalt-Start (App durch den Link gestartet)
 * = einmalig `App.getLaunchUrl()`. No-op im Browser/PWA.
 */
export default function AirlockDeepLinkRouter() {
  useEffect(() => {
    let remove: (() => void) | null = null;
    let cancelled = false;

    function handleTagUrl(rawUrl: string): void {
      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        return;
      }
      if (url.hostname !== TAG_HOST) return;
      const m = url.pathname.match(/^\/t\/([^/]+)\/?$/); // exakt /t/<code>
      if (!m) return;
      const code = decodeURIComponent(m[1]);
      // Auflösung + Redirect macht der Server; wir übergeben nur den Code (re-enkodiert).
      window.location.href = `/airlock/open?code=${encodeURIComponent(code)}`;
    }

    (async () => {
      try {
        if (!(await isNativePlatform())) return;
        const { App } = await import("@capacitor/app");
        const handle = await App.addListener("appUrlOpen", (event) => handleTagUrl(event.url));
        if (cancelled) handle.remove();
        else remove = () => handle.remove();
        const launch = await App.getLaunchUrl();
        if (launch?.url) handleTagUrl(launch.url);
      } catch (err) {
        console.error("[AirlockDeepLinkRouter]", err);
      }
    })();

    return () => {
      cancelled = true;
      remove?.();
    };
  }, []);

  return null;
}
