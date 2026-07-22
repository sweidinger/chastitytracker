import { Lock } from "lucide-react";
import { formatDateTime, formatDate, formatTime, hasExifMismatch, toDateLocale, isTimeCorrected, APP_TZ } from "@/lib/utils";
import { getTranslations, getLocale } from "next-intl/server";
import { getKombinierterPill } from "@/lib/kontrollePills";
import { CATEGORY_COLOR_HEX, isValidCategoryColor, DEFAULT_USER_CATEGORY_COLOR } from "@/lib/categoryConstants";
import { GRUND_I18N_KEYS } from "@/lib/constants";
import CategoryIconRender from "@/app/components/CategoryIcon";
import PauseAwareTimer from "./PauseAwareTimer";
import type { SessionEventData } from "./SessionEventRow";
import SessionTimeline from "./SessionTimeline";
import LiveTrainingGoals from "./LiveTrainingGoals";
import SperrzeitRemaining from "@/app/components/SperrzeitRemaining";
import type { PauseQuotaEntry } from "@/lib/pauseService";
import type { SessionEvent } from "@/lib/sessionHelpers";

interface Props {
  sessionStart: Date;
  interruptionPausedMs?: number;
  now: Date;
  events: SessionEvent[];
  categoryName: string;
  /** Category color slug (e.g. "cat-plum"). */
  categoryColor: string;
  categoryIcon: string;
  deviceName: string;
  /** ISO string of an active plug pause (PAUSE_BEGIN without PAUSE_END). */
  activePlugPauseSince?: string | null;
  /** Active category goal targets (null when none) — same shape as the KG TrainingVorgabe. */
  goal: {
    minProTagH: number | null;
    minProWocheH: number | null;
    minProMonatH: number | null;
    minProJahrH: number | null;
  } | null;
  tagH: number;
  wocheH: number;
  monatH: number;
  jahrH: number;
  sperrzeitEndetAt: Date | null;
  sperrzeitUnbefristet?: boolean;
  sperrzeitNachricht?: string | null;
  tz?: string;
  /** Heutiges Rest-Kontingent der Plug-Pausen (Reinigung/Toilette). Nur erlaubte Arten; Plug-Toilette
   *  ist immer dabei (unbegrenzt). Leer/weglassen = keine Zeile. */
  pauseQuota?: PauseQuotaEntry[];
}

/** Große Session-Karte für die aktive PLUG-Session — analog zur KG-Karte (LaufendeSessionCard),
 *  aber in der Plug-Kategorie-Farbe, mit Gerätename, Ziel-Fortschritt und Event-Timeline. */
export default async function LaufendePlugSessionCard({
  sessionStart,
  interruptionPausedMs = 0,
  now,
  events,
  categoryName,
  categoryColor,
  categoryIcon,
  deviceName,
  activePlugPauseSince = null,
  goal,
  tagH,
  wocheH,
  monatH,
  jahrH,
  sperrzeitEndetAt,
  sperrzeitUnbefristet = false,
  sperrzeitNachricht,
  tz = APP_TZ,
  pauseQuota = [],
}: Props) {
  const t = await getTranslations("dashboard");
  const ta = await getTranslations("admin");
  const tOpen = await getTranslations("openForm");
  const dl = toDateLocale(await getLocale());

  const sessionStartStr = formatDateTime(sessionStart, dl, tz);
  const sperrzeitStr = sperrzeitEndetAt ? formatDateTime(sperrzeitEndetAt, dl, tz) : null;
  const showSperrzeit = sperrzeitStr !== null || sperrzeitUnbefristet;

  const hasVorgabe =
    goal &&
    (goal.minProTagH != null || goal.minProWocheH != null || goal.minProMonatH != null || goal.minProJahrH != null);

  const safeColor = isValidCategoryColor(categoryColor) ? categoryColor : DEFAULT_USER_CATEGORY_COLOR;
  const hex = CATEGORY_COLOR_HEX[safeColor];

  return (
    <div className="bg-surface rounded-2xl overflow-hidden shadow-card border border-border">
      {/* ── Colored status header (category color) ── */}
      <div
        className="text-white px-5 py-4"
        style={{ background: `linear-gradient(to bottom right, ${hex}, ${hex}cc)` }}
      >
        <div className="flex items-start gap-3">
          <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 bg-white/15 mt-0.5">
            <CategoryIconRender name={categoryIcon} className="size-6" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold uppercase tracking-widest opacity-60 mb-0.5">{t("sessionTitle")}</p>
            <p className="text-2xl font-bold leading-tight truncate">{categoryName}</p>
            <p className="text-xs opacity-70 mt-0.5 truncate">{deviceName}</p>
            <p className="text-xs opacity-60 mt-1">
              {t("sessionSince")} {sessionStartStr}
            </p>
            <PauseAwareTimer
              since={sessionStart.toISOString()}
              alreadyPausedMs={interruptionPausedMs}
              activePauseSince={activePlugPauseSince}
              pauseStartHref="/dashboard/new/pause-start?device=PLUG"
              pauseEndHref="/dashboard/new/pause-end?device=PLUG"
            />
          </div>
        </div>

        {/* Rest-Kontingent der Plug-Pausen (Reinigung/Toilette) für heute */}
        {pauseQuota.length > 0 && (
          <div className="mt-3">
            <p className="text-xs font-semibold uppercase tracking-widest opacity-60 mb-0.5">{t("pauseQuotaLabel")}</p>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs opacity-80">
              {pauseQuota.map((q) => (
                <span key={q.grund}>
                  <span className="opacity-70">{t(q.grund === "REINIGUNG" ? "pauseGrundReinigung" : "pauseGrundToilette")}:</span>{" "}
                  {q.remaining === null
                    ? t("pauseQuotaUnlimited")
                    : t("pauseQuotaRemaining", { remaining: q.remaining, max: q.max })}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Ziel-Fortschritt – live-updating client component (identisch zur KG-Karte) */}
        {hasVorgabe && (
          <LiveTrainingGoals
            serverNow={now.toISOString()}
            tagH={tagH}
            wocheH={wocheH}
            monatH={monatH}
            jahrH={jahrH}
            activeVorgabe={goal}
          />
        )}
      </div>

      {/* ── Timeline (Pausen + Kontrollen) ── */}
      {events.length > 0 && (
        <SessionTimeline
          events={events.map<SessionEventData>((ev) => {
            const dateStr = formatDate(ev.time, dl, tz);
            const timeStr = formatTime(ev.time, dl, tz);
            const exifStr = ev.imageExifTime && hasExifMismatch(ev.imageExifTime, ev.time)
              ? formatDateTime(ev.imageExifTime, dl, tz)
              : null;
            const kombiniertePill = getKombinierterPill(
              ev.kontrolleAnforderungStatus ?? null,
              ev.kontrolleVerifikationStatus ?? null,
              ta,
            );
            const reinigungPillLabel = ev.reinigungGrund
              ? tOpen(GRUND_I18N_KEYS[ev.reinigungGrund as keyof typeof GRUND_I18N_KEYS] ?? "grundReinigung")
              : null;
            return {
              type: ev.type,
              timeIso: ev.time.toISOString(),
              dateStr,
              timeStr,
              imageUrl: ev.imageUrl,
              codeImageUrl: ev.codeImageUrl ?? null,
              exifStr,
              note: ev.note,
              entryId: ev.entryId,
              captureHref: null,
              deadlineStr: ev.deadline ? formatDateTime(ev.deadline, dl, tz) : null,
              isOverdue: ev.kontrolleAnforderungStatus === "overdue",
              kontrolleCode: ev.kontrolleCode ?? null,
              kontrolleKommentar: ev.kontrolleKommentar ?? null,
              kombiniertePillLabel: kombiniertePill?.label ?? null,
              kombiniertePillCls: kombiniertePill?.cls ?? null,
              orgasmusArt: ev.orgasmusArt ?? null,
              pauseDurationStr: ev.pauseDurationStr ?? null,
              reinigungPillLabel,
              timeCorrected: isTimeCorrected(ev.time, ev.submittedAt),
              timeCorrectedSystemStr: isTimeCorrected(ev.time, ev.submittedAt)
                ? formatDateTime(ev.submittedAt!, dl, tz) : null,
            };
          })}
          sessionStart={sessionStart.toISOString()}
          nowIso={now.toISOString()}
          locale={dl}
          mode="active"
          storageScope="active-plug"
        />
      )}

      {/* ── Sperrzeit footer ── */}
      {showSperrzeit && (
        <div className="bg-sperrzeit-bg border-t border-sperrzeit-border px-5 py-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-b-2xl">
          <Lock size={13} className="text-sperrzeit shrink-0" />
          <span className="text-sm font-semibold text-sperrzeit-text">
            {sperrzeitStr ? <>{t("sessionLockedUntil")} {sperrzeitStr}</> : t("sessionLockedIndefinite")}
          </span>
          {sperrzeitEndetAt && (
            <SperrzeitRemaining
              endetAt={sperrzeitEndetAt.toISOString()}
              className="text-xs font-medium text-sperrzeit-text opacity-80"
            />
          )}
          {sperrzeitNachricht && (
            <span className="text-xs text-sperrzeit truncate">· {sperrzeitNachricht}</span>
          )}
        </div>
      )}
    </div>
  );
}
