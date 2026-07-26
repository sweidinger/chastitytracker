"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Pause, Play } from "lucide-react";
import { useTranslations, useLocale } from "next-intl";
import Card from "@/app/components/Card";
import { formatElapsedMs } from "@/lib/utils";
import { categoryStyle, wearActionHref } from "@/lib/categoryConstants";
import CategoryPhotoThumb from "@/app/components/CategoryPhotoThumb";
import DashboardBlock from "@/app/components/DashboardBlock";

export interface ActiveWearSessionRow {
  categoryId: string;
  categoryName: string;
  categoryColor: string;
  categoryIcon: string;
  deviceName: string;
  /** ISO string of session start. */
  since: string;
  /** Foto vom Trage-Beginn; ohne eines fällt CategoryPhotoThumb aufs Kategorie-Icon zurück. Nicht
   *  optional — sonst liesse ein dritter Aufrufer das Feld stillschweigend weg. */
  imageUrl: string | null;
  /** Override the default wear-end href (e.g. session-end for session categories). */
  endHref?: string;
  /** ISO string of active pause start; null/undefined = not paused. When set, the timer freezes and a ▶ button is shown. */
  activePauseSince?: string | null;
  /** Pause-start URL (⏸ button). When provided, a pause button is shown in the row. */
  pauseStartHref?: string;
  /** Pause-end URL (▶ button). */
  pauseEndHref?: string;
}

interface Props {
  sessions: ActiveWearSessionRow[];
  /** Server clock at render — used as the initial tick reference. */
  serverNow: string;
  /** Keyholder-Sicht: die Karte gehört zu DIESEM Sub und muss auf die Admin-Route zeigen.
   *  Ohne das führte sie den Keyholder auf `/dashboard/…`, wo `proxy.ts` ihn nach `/admin`
   *  zurückwirft — die Karte war für ihn schlicht ein toter Link. */
  adminUserId?: string;
}

/** Renders one compact row per active wear-session (Plug, Collar, ...).
 *  Per UX Architect spec: stack of compact cards below the primary KG card.
 *  Hidden when feature flag is off or no sessions are active. */
export default function ActiveWearSessions({ sessions, serverNow, adminUserId }: Props) {
  const t = useTranslations("wearForm");
  const locale = useLocale();
  const [now, setNow] = useState<number>(() => Date.parse(serverNow));

  useEffect(() => {
    if (sessions.length === 0) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [sessions.length]);

  if (sessions.length === 0) return null;

  return (
    <DashboardBlock>
      <ul className="flex flex-col gap-2">
        {sessions.map((s) => {
          const style = categoryStyle(s.categoryColor);
          const pauseStartMs = s.activePauseSince ? Date.parse(s.activePauseSince) : null;
          const isPaused = !!pauseStartMs;
          // Timer freezes at pause-start when paused; grows normally otherwise
          const frozenAt = pauseStartMs ?? now;
          const elapsedMs = Math.max(0, frozenAt - Date.parse(s.since));
          const pauseElapsedMs = pauseStartMs ? Math.max(0, now - pauseStartMs) : 0;
          const endHref = s.endHref ?? wearActionHref({ categoryId: s.categoryId, active: true, adminUserId });
          const hasPause = !!(s.pauseStartHref || s.pauseEndHref);

          return (
            <li key={s.categoryId}>
              <Card>
                <div
                  className="flex items-center gap-3 p-3 border-l-[3px]"
                  style={{ borderLeftColor: style.borderColor }}
                >
                  <Link href={endHref} className="flex items-center gap-3 flex-1 min-w-0 active:opacity-70 transition">
                    {/* Trage-Beginn-Foto dort, wo sonst das Kategorie-Symbol sitzt; ohne Foto Fallback aufs Icon. */}
                    <CategoryPhotoThumb
                      imageUrl={s.imageUrl}
                      categoryColor={s.categoryColor}
                      categoryIcon={s.categoryIcon}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-foreground truncate">{s.categoryName}</p>
                      <p className="text-xs text-foreground-muted truncate">{s.deviceName}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <span className="font-mono text-base font-semibold tabular-nums text-foreground" suppressHydrationWarning>
                        {formatElapsedMs(elapsedMs, locale, false)}
                      </span>
                      {isPaused && (
                        <p className="text-xs text-foreground-muted tabular-nums font-mono" suppressHydrationWarning>
                          ⏸ {formatElapsedMs(pauseElapsedMs, locale, false)}
                        </p>
                      )}
                      {!hasPause && (
                        <span className="text-xs text-foreground-faint block">{t("endShort")}</span>
                      )}
                    </div>
                  </Link>
                  {/* Pause button — only shown when this session supports pausing (separate link: no nested <a>) */}
                  {hasPause && (
                    <Link
                      href={isPaused ? (s.pauseEndHref ?? "#") : (s.pauseStartHref ?? "#")}
                      className="shrink-0 size-9 rounded-lg flex items-center justify-center bg-background-subtle hover:bg-background-hover active:bg-background-active transition"
                      aria-label={isPaused ? t("pauseEnd") : t("pauseStart")}
                    >
                      {isPaused
                        ? <Play size={18} className="text-foreground" fill="currentColor" />
                        : <Pause size={18} className="text-foreground" />}
                    </Link>
                  )}
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
    </DashboardBlock>
  );
}
