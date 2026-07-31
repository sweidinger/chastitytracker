"use client";

import { useEffect } from "react";
import { isNativePlatform } from "@/lib/nativePush";

const TAG_HOST = "nfc.neurorelatepoly.app";
// getLaunchUrl() „klebt": liefert bei jedem Reload dieselbe /t/<code>-URL. Ohne Guard entsteht mit
// window.location.href eine Reload-Schleife (Flackern). Die verarbeitete URL im sessionStorage merken
// (überlebt den vollen Reload; ein Modul-Flag nicht) und beim erneuten Mount überspringen.
const LAUNCH_GUARD_KEY = "airlockHandledLaunchUrl";

/**
 * Öffnet beim Antippen eines Airlock-Tags (Universal Link) die passende Ansicht INNERHALB der App.
 * Spiegelt NativePushRouter (nativer Event -> same-origin-Navigation). Die Auflösung Code -> Ziel
 * macht der Server (/airlock/open), damit kein Prisma-/Server-Modul in den Client gezogen wird.
 */
export default function AirlockDeepLinkRouter() {
  useEffect(() => {
    let remove: (() => void) | null = null;
    let cancelled = false;

    function extractCode(rawUrl: string): string | null {
      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        return null;
      }
      if (url.hostname !== TAG_HOST) return null;
      const m = url.pathname.match(/^\/t\/([^/]+)\/?$/); // exakt /t/<code>
      return m ? decodeURIComponent(m[1]) : null;
    }

    function go(code: string): void {
      // replace() statt href: kein zusätzlicher History-Eintrag. Server löst auf und leitet weiter.
      window.location.replace(`/airlock/open?code=${encodeURIComponent(code)}`);
    }

    (async () => {
      try {
        if (!(await isNativePlatform())) return;
        const { App } = await import("@capacitor/app");

        // WARM-START: echtes Tap-Event bei laufender App -> immer behandeln (feuert pro Tap einmal).
        const handle = await App.addListener("appUrlOpen", (e) => {
          const code = extractCode(e.url);
          if (code) go(code);
        });
        if (cancelled) handle.remove();
        else remove = () => handle.remove();

        // KALT-START: getLaunchUrl „klebt" -> nur EINMAL pro App-Lauf behandeln (Guard s.o.).
        const launch = await App.getLaunchUrl();
        if (launch?.url && sessionStorage.getItem(LAUNCH_GUARD_KEY) !== launch.url) {
          sessionStorage.setItem(LAUNCH_GUARD_KEY, launch.url);
          const code = extractCode(launch.url);
          if (code) go(code);
        }
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
