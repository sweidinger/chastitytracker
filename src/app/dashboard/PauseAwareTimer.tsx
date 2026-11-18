"use client";

/**
 * Fork: Pause-bewusste Session-Anzeige für Upstreams `StateHero`.
 *
 * Zwei Teile, weil der Held die Zahl (`value`) und das, was am Zustand hängt (`children`), getrennt
 * setzt:
 *  - {@link PauseAwareDuration} — die Session-Dauer. Läuft eine Pause, friert sie beim Pause-Start
 *    ein (abgeschlossene Pausen sind schon abgezogen). Sekunden nur in der ersten Stunde — dieselbe
 *    Regel wie `SessionDurationBadge`.
 *  - {@link PauseControl} — „Pause läuft …" plus der ⏸/▶-Knopf zum Pause-Formular.
 */

import { useLocale, useTranslations } from "next-intl";
import { formatElapsedMs } from "@/lib/utils";
import useTick from "@/app/hooks/useTick";
import { Pause, Play } from "lucide-react";
import Link from "next/link";
import type { PauseQuotaEntry } from "@/lib/pauseService";

/** Ab hier tragen Sekunden nichts mehr bei: eine Stunde (wie `SessionDurationBadge`). */
const SECONDS_UNTIL_MS = 3_600_000;

export function PauseAwareDuration({ since, alreadyPausedMs = 0, activePauseSince }: {
  since: string;
  /** ms bereits abgeschlossener Pausen (wird vom Session-Timer subtrahiert). */
  alreadyPausedMs?: number;
  /** ISO-String, wenn gerade eine Pause läuft; null = nicht pausiert. */
  activePauseSince?: string | null;
}) {
  const locale = useLocale();
  useTick(1000);
  const frozenAtMs = activePauseSince ? new Date(activePauseSince).getTime() : Date.now();
  const ms = Math.max(0, frozenAtMs - new Date(since).getTime() - alreadyPausedMs);
  return (
    <span suppressHydrationWarning className="tabular-nums">
      {formatElapsedMs(ms, locale, ms < SECONDS_UNTIL_MS)}
    </span>
  );
}

export function PauseControl({ activePauseSince, pauseStartHref, pauseEndHref }: {
  activePauseSince?: string | null;
  /** Href für den Pause-Start (⏸). */
  pauseStartHref: string;
  /** Href für das Pause-Ende-Formular (▶). */
  pauseEndHref: string;
}) {
  const locale = useLocale();
  const t = useTranslations("dashboard");
  useTick(1000);
  const pauseStartMs = activePauseSince ? new Date(activePauseSince).getTime() : null;
  const isPaused = pauseStartMs !== null;
  const pauseElapsedMs = pauseStartMs !== null ? Math.max(0, Date.now() - pauseStartMs) : 0;

  return (
    <div className="relative mt-3 flex items-center gap-3">
      <Link
        href={isPaused ? pauseEndHref : pauseStartHref}
        className="shrink-0 size-10 rounded-xl border border-border bg-surface-raised hover:bg-background-subtle active:bg-border-subtle flex items-center justify-center transition-colors text-foreground"
        aria-label={isPaused ? t("pauseEnd") : t("pauseStart")}
      >
        {isPaused
          ? <Play size={18} fill="currentColor" />
          : <Pause size={18} />}
      </Link>
      <span className="text-neben text-foreground-muted tabular-nums" suppressHydrationWarning>
        {isPaused
          ? <>{t("pauseRunning")} {formatElapsedMs(pauseElapsedMs, locale, false)}</>
          : t("pauseStart")}
      </span>
    </div>
  );
}

/** Heutiges Rest-Kontingent der Pausen (Reinigung/Toilette) — geteilt von KG- und Plug-Karte.
 *  Leer = keine Zeile. */
export function PauseQuotaLine({ quota }: { quota: PauseQuotaEntry[] }) {
  const t = useTranslations("dashboard");
  if (quota.length === 0) return null;
  return (
    <p className="relative mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-neben text-foreground-muted">
      <span className="font-semibold text-foreground">{t("pauseQuotaLabel")}</span>
      {quota.map((q) => (
        <span key={q.grund}>
          {t(q.grund === "REINIGUNG" ? "pauseGrundReinigung" : "pauseGrundToilette")}:{" "}
          {q.remaining === null
            ? t("pauseQuotaUnlimited")
            : t("pauseQuotaRemaining", { remaining: q.remaining, max: q.max })}
        </span>
      ))}
    </p>
  );
}
