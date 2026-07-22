import { Lock } from "lucide-react";
import { formatDateTime, formatDate, formatTime, hasExifMismatch, toDateLocale, isTimeCorrected, APP_TZ } from "@/lib/utils";
export type { SessionEvent } from "@/lib/sessionHelpers";
import { getTranslations, getLocale } from "next-intl/server";
import { getKombinierterPill } from "@/lib/kontrollePills";
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
  sperrzeitEndetAt: Date | null;
  sperrzeitUnbefristet?: boolean;
  sperrzeitNachricht?: string | null;
  /** Nur Keyholder-Sicht: geplante (noch nicht ausgelöste) Sperrzeit → Footer zeigt "geplant für"
   *  statt "gesperrt bis". Sub-Sichten setzen dies NIE (geplante bleiben für den Sub unsichtbar). */
  sperrzeitScheduledFor?: Date | null;
  /** Erlaubt diese Sperre Reinigungsöffnungen? Fertig übersetzt (i18n bleibt beim Aufrufer).
   *  Weglassen = nicht anzeigen — ein Sub, der grundsätzlich nicht reinigen darf, soll keine Zeile
   *  über etwas lesen, das seine Einstellung ohnehin verbietet. */
  cleaningNote?: string | null;
  activeVorgabe: {
    minProTagH: number | null;
    minProWocheH: number | null;
    minProMonatH: number | null;
    minProJahrH: number | null;
  } | null;
  tagH: number;
  wocheH: number;
  monatH: number;
  jahrH: number;
  /** Governing timezone of the data owner (sub). Defaults to APP_TZ (Europe/Zurich). */
  tz?: string;
  /** ISO-Zeitstempel einer aktiven Cage-Pause (PAUSE_BEGIN ohne PAUSE_END). */
  activeCagePauseSince?: string | null;
  /** Heutiges Rest-Kontingent der Cage-Pausen (Reinigung/Toilette). Nur erlaubte Arten enthalten;
   *  leer/weglassen = keine Zeile. Spiegelt die Tageslimit-Durchsetzung in api/entries. */
  pauseQuota?: PauseQuotaEntry[];
  /** Name des getragenen KG-Geräts (null = keins gewählt → Unterzeile ausgeblendet). */
  deviceName?: string | null;
  /** Blendet die „Gerät"-Zeile im Kontroll-Detail ein (true, wenn der Nutzer Geräte hat). */
  userHasDevices?: boolean;
}

export default async function LaufendeSessionCard({
  sessionStart,
  interruptionPausedMs = 0,
  now,
  events,
  sperrzeitEndetAt,
  sperrzeitUnbefristet = false,
  sperrzeitNachricht,
  sperrzeitScheduledFor = null,
  cleaningNote,
  activeVorgabe,
  tagH,
  wocheH,
  monatH,
  jahrH,
  tz = APP_TZ,
  activeCagePauseSince = null,
  deviceName = null,
  userHasDevices = false,
  pauseQuota = [],
}: Props) {
  const t = await getTranslations("dashboard");
  const tCommon = await getTranslations("common");
  const ta = await getTranslations("admin");
  const dl = toDateLocale(await getLocale());

  const sessionStartStr = formatDateTime(sessionStart, dl, tz);
  const sperrzeitStr = sperrzeitEndetAt ? formatDateTime(sperrzeitEndetAt, dl, tz) : null;
  const scheduledForStr = sperrzeitScheduledFor ? formatDateTime(sperrzeitScheduledFor, dl, tz) : null;
  const showSperrzeit = sperrzeitStr !== null || sperrzeitUnbefristet || scheduledForStr !== null;

  const hasVorgabe =
    activeVorgabe &&
    (activeVorgabe.minProTagH != null ||
      activeVorgabe.minProWocheH != null ||
      activeVorgabe.minProMonatH != null ||
      activeVorgabe.minProJahrH != null);

  return (
    <div className="bg-surface rounded-2xl overflow-hidden shadow-card border border-border">
      {/* ── Green status header ── */}
      <div className="bg-gradient-to-br from-emerald-600 to-emerald-500 text-white px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 bg-white/10 mt-0.5">
            <Lock size={24} strokeWidth={2} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold uppercase tracking-widest opacity-60 mb-0.5">{t("sessionTitle")}</p>
            <p className="text-2xl font-bold leading-tight">{t("locked")}</p>
            {deviceName && <p className="text-xs opacity-70 mt-0.5 truncate">{deviceName}</p>}
            <p className="text-xs opacity-60 mt-1">
              {t("sessionSince")} {sessionStartStr}
            </p>
            <PauseAwareTimer
              since={sessionStart.toISOString()}
              alreadyPausedMs={interruptionPausedMs}
              activePauseSince={activeCagePauseSince}
              pauseStartHref="/dashboard/new/pause-start?device=CAGE"
              pauseEndHref="/dashboard/new/pause-end?device=CAGE"
            />
          </div>
        </div>

        {/* Rest-Kontingent der Cage-Pausen (Reinigung/Toilette) für heute */}
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

        {/* Trainingsvorgaben – live-updating client component */}
        {hasVorgabe && (
          <LiveTrainingGoals
            serverNow={now.toISOString()}
            tagH={tagH}
            wocheH={wocheH}
            monatH={monatH}
            jahrH={jahrH}
            activeVorgabe={activeVorgabe}
          />
        )}
      </div>

      {/* ── Timeline (buckets + flat fallback for short sessions) ── */}
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
            captureHref: !ev.entryId && ev.type === "kontrolle" && ev.kontrolleCode
              ? `/dashboard/new/pruefung?code=${ev.kontrolleCode}`
              : null,
            deadlineStr: ev.deadline ? formatDateTime(ev.deadline, dl, tz) : null,
            isOverdue: ev.kontrolleAnforderungStatus === "overdue",
            kontrolleCode: ev.kontrolleCode ?? null,
            kontrolleKommentar: ev.kontrolleKommentar ?? null,
            kombiniertePillLabel: kombiniertePill?.label ?? null,
            kombiniertePillCls: kombiniertePill?.cls ?? null,
            orgasmusArt: ev.orgasmusArt ?? null,
            pauseDurationStr: ev.pauseDurationStr ?? null,
            timeCorrected: isTimeCorrected(ev.time, ev.submittedAt),
            timeCorrectedSystemStr: isTimeCorrected(ev.time, ev.submittedAt)
              ? formatDateTime(ev.submittedAt!, dl, tz) : null,
            deviceName: ev.deviceName ?? null,
            showDevice: userHasDevices,
          };
        })}
        sessionStart={sessionStart.toISOString()}
        nowIso={now.toISOString()}
        locale={dl}
        mode="active"
        storageScope="active"
      />

      {/* ── Sperrzeit footer ── */}
      {showSperrzeit && (
        <div className="bg-sperrzeit-bg border-t border-sperrzeit-border px-5 py-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-b-2xl">
          <Lock size={13} className="text-sperrzeit shrink-0" />
          <span className="text-sm font-semibold text-sperrzeit-text">
            {scheduledForStr
              ? <>{ta("scheduledForLabel")}: {scheduledForStr}</>
              : sperrzeitStr ? <>{t("sessionLockedUntil")} {sperrzeitStr}</> : t("sessionLockedIndefinite")}
          </span>
          {!scheduledForStr && sperrzeitEndetAt && (
            <SperrzeitRemaining
              endetAt={sperrzeitEndetAt.toISOString()}
              className="text-xs font-medium text-sperrzeit-text opacity-80"
            />
          )}
          {sperrzeitNachricht && (
            <span className="text-xs text-sperrzeit truncate">· {sperrzeitNachricht}</span>
          )}
          {cleaningNote && (
            <span className="text-xs text-sperrzeit shrink-0">· {cleaningNote}</span>
          )}
        </div>
      )}
    </div>
  );
}
