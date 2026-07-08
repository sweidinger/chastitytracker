"use client";

/**
 * PauseAwareTimer — zeigt Session-Dauer + optionalen Pause-Status live.
 *
 * Wenn `activePauseSince` gesetzt ist (Pause läuft):
 *   - Session-Timer friert ein (zeigt Dauer bis Pause-Start)
 *   - Pause-Dauer wächst live (Countdown seit Pause-Start)
 *
 * Wenn nicht pausiert:
 *   - Normaler Session-Timer (früherer Verhalten von SessionDurationBadge)
 */

import { useLocale, useTranslations } from "next-intl";
import { formatElapsedMs } from "@/lib/utils";
import useTick from "@/app/hooks/useTick";
import { Pause, Play } from "lucide-react";
import Link from "next/link";

interface Props {
  since: string;
  /** ms bereits abgeschlossener Pausen (wird vom Session-Timer subtrahiert). */
  alreadyPausedMs?: number;
  /** ISO-String wenn gerade eine Pause läuft; null wenn nicht pausiert. */
  activePauseSince?: string | null;
  /** Href für den Pause-Start-Button (⏸). */
  pauseStartHref: string;
  /** Href für das Pause-Ende-Formular (▶). */
  pauseEndHref: string;
}

export default function PauseAwareTimer({
  since,
  alreadyPausedMs = 0,
  activePauseSince,
  pauseStartHref,
  pauseEndHref,
}: Props) {
  const locale = useLocale();
  const t = useTranslations("dashboard");
  useTick(1000);

  const now = Date.now();
  const sessionStartMs = new Date(since).getTime();
  const isPaused = !!activePauseSince;
  const pauseStartMs = activePauseSince ? new Date(activePauseSince).getTime() : null;

  // Session elapsed = from sessionStart to (pause start if paused, else now) minus already-paused
  const frozenAtMs = pauseStartMs ?? now;
  const sessionElapsedMs = Math.max(0, frozenAtMs - sessionStartMs - alreadyPausedMs);

  // Pause duration = time since pause started
  const pauseElapsedMs = pauseStartMs ? Math.max(0, now - pauseStartMs) : 0;

  return (
    <div className="flex items-center gap-3 mt-2">
      {/* Session timer (or frozen + pause timer) */}
      <div className="flex-1 min-w-0">
        <p className="text-3xl font-bold tabular-nums leading-tight" suppressHydrationWarning>
          {formatElapsedMs(sessionElapsedMs, locale, true)}
        </p>
        {isPaused && (
          <div className="flex items-center gap-1 mt-0.5">
            <Pause size={11} className="opacity-70" />
            <span className="text-xs font-mono opacity-80 tabular-nums" suppressHydrationWarning>
              {t("pauseRunning")} {formatElapsedMs(pauseElapsedMs, locale, false)}
            </span>
          </div>
        )}
      </div>

      {/* ⏸/▶ Button */}
      <Link
        href={isPaused ? pauseEndHref : pauseStartHref}
        className="shrink-0 size-10 rounded-xl bg-white/15 hover:bg-white/25 active:bg-white/30 flex items-center justify-center transition-colors"
        aria-label={isPaused ? t("pauseEnd") : t("pauseStart")}
      >
        {isPaused
          ? <Play size={20} className="text-white" fill="currentColor" />
          : <Pause size={20} className="text-white" />
        }
      </Link>
    </div>
  );
}
