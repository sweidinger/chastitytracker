import { formatDateTime, formatDate, formatTime, hasExifMismatch, toDateLocale, isTimeCorrected, APP_TZ } from "@/lib/utils";
import { getTranslations, getLocale } from "next-intl/server";
import { getKombinierterPill } from "@/lib/kontrollePills";
import { categoryStyle } from "@/lib/categoryConstants";
import { GRUND_I18N_KEYS } from "@/lib/constants";
import { hasVisibleGoalRow, periodEndsMs, type VorgabeTargets } from "@/lib/goalFulfillment";
import CategoryIconRender from "@/app/components/CategoryIcon";
import StateHero from "@/app/components/StateHero";
import Section from "@/app/components/Section";
import LockPeriodRemaining from "@/app/components/LockPeriodRemaining";
import { LockClosedIcon } from "@/app/components/lockIcons";
import { PauseAwareDuration, PauseControl, PauseQuotaLine } from "./PauseAwareTimer";
import type { SessionEventData } from "./SessionEventRow";
import SessionTimeline from "./SessionTimeline";
import LiveTrainingGoals from "./LiveTrainingGoals";
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
  /** Aufgelöste Ziele der Plug-Kategorie (null = keine Vorgabe) — dieselbe Form wie das KG-Ziel. */
  goal: VorgabeTargets | null;
  tagH: number;
  wocheH: number;
  monatH: number;
  jahrH: number;
  lockPeriodEndsAt: Date | null;
  lockPeriodIndefinite?: boolean;
  lockPeriodMessage?: string | null;
  tz?: string;
  /** Heutiges Rest-Kontingent der Plug-Pausen (Reinigung/Toilette). Nur erlaubte Arten; Plug-Toilette
   *  ist immer dabei (unbegrenzt). Leer/weglassen = keine Zeile. */
  pauseQuota?: PauseQuotaEntry[];
  /** Blendet die „Gerät"-Zeile im Kontroll-Detail ein (true, wenn der Nutzer Geräte hat). */
  userHasDevices?: boolean;
}

/** Fork: grosse Session-Karte für die aktive PLUG-Session — dieselbe Figur wie die KG-Karte
 *  (`LaufendeSessionCard`: `StateHero` + Ziele + Zeitleiste), mit der Kategorie als Wort und ihrem
 *  Symbol in der Kategorie-Farbe, Gerätename, Pausen und Plug-Sperrzeit. Sicht des Trägers. */
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
  lockPeriodEndsAt,
  lockPeriodIndefinite = false,
  lockPeriodMessage,
  tz = APP_TZ,
  pauseQuota = [],
  userHasDevices = false,
}: Props) {
  const t = await getTranslations("dashboard");
  const ta = await getTranslations("admin");
  const tOpen = await getTranslations("openForm");
  const dl = toDateLocale(await getLocale());

  const sessionStartStr = formatDateTime(sessionStart, dl, tz);
  const lockPeriodEndsAtStr = lockPeriodEndsAt ? formatDateTime(lockPeriodEndsAt, dl, tz) : null;
  const showLockPeriod = lockPeriodEndsAtStr !== null || lockPeriodIndefinite;
  const hasVorgabe = goal != null && hasVisibleGoalRow(goal.targetH);
  const iconColor = categoryStyle(categoryColor).color;

  return (
    <section className="flex flex-col gap-4">
      <StateHero
        tone="lock"
        word={categoryName}
        icon={<CategoryIconRender name={categoryIcon} className="size-4 shrink-0" style={{ color: iconColor }} />}
        value={<PauseAwareDuration since={sessionStart.toISOString()} alreadyPausedMs={interruptionPausedMs} activePauseSince={activePlugPauseSince} />}
        footnote={`${deviceName ? `${deviceName} · ` : ""}${t("sessionSince")} ${sessionStartStr}`}
      >
        {showLockPeriod && (
          <p className="relative mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-fliess text-foreground-muted">
            <LockClosedIcon size={13} className="shrink-0 text-sperrzeit" />
            <span className="font-semibold text-foreground">
              {lockPeriodEndsAtStr ? <>{t("sessionLockedUntil")} {lockPeriodEndsAtStr}</> : t("sessionLockedIndefinite")}
            </span>
            {lockPeriodEndsAt && <LockPeriodRemaining endsAt={lockPeriodEndsAt.toISOString()} />}
            {lockPeriodMessage && <span className="truncate">· {lockPeriodMessage}</span>}
          </p>
        )}
        <PauseControl
          activePauseSince={activePlugPauseSince}
          pauseStartHref="/dashboard/new/pause-start?device=PLUG"
          pauseEndHref="/dashboard/new/pause-end?device=PLUG"
        />
        <PauseQuotaLine quota={pauseQuota} />
      </StateHero>

      {hasVorgabe && (
        <LiveTrainingGoals
          serverNow={now.toISOString()}
          periodEndMs={periodEndsMs(now, tz)}
          tagH={tagH}
          wocheH={wocheH}
          monatH={monatH}
          jahrH={jahrH}
          activeVorgabe={goal}
        />
      )}

      {/* ── Zeitleiste (Pausen + Kontrollen) ── */}
      {events.length > 0 && (
        <Section title={t("currentWearTime")}>
          <SessionTimeline
            tz={tz}
            events={events.map<SessionEventData>((ev) => {
              const timeCorrected = isTimeCorrected(ev.time, ev.submittedAt);
              const kombiniertePill = ev.type === "kontrolle"
                ? getKombinierterPill(ev.kontrolleAnforderungStatus ?? null, ev.kontrolleVerifikationStatus ?? null, ta)
                : null;
              return {
                type: ev.type,
                timeIso: ev.time.toISOString(),
                dateStr: formatDate(ev.time, dl, tz),
                timeStr: formatTime(ev.time, dl, tz),
                imageUrl: ev.imageUrl,
                codeImageUrl: ev.codeImageUrl ?? null,
                codeRevealed: undefined,
                captureDisabled: false,
                exifStr: ev.imageExifTime && hasExifMismatch(ev.imageExifTime, ev.time)
                  ? formatDateTime(ev.imageExifTime, dl, tz)
                  : null,
                note: ev.note,
                entryId: ev.entryId,
                captureHref: null,
                deadlineStr: ev.deadline ? formatDateTime(ev.deadline, dl, tz) : null,
                isOverdue: ev.kontrolleAnforderungStatus === "overdue",
                kontrolleCode: ev.kontrolleCode ?? null,
                kontrolleKommentar: ev.kontrolleKommentar ?? null,
                kombiniertePillLabel: kombiniertePill?.label ?? null,
                kombiniertePillCls: kombiniertePill?.cls ?? null,
                review: null,
                verifyFailure: ev.kontrolleVerifikationFailure ?? null,
                orgasmusArt: ev.orgasmusArt ?? null,
                pauseDurationStr: ev.pauseDurationStr ?? null,
                // Plug-Pausen tragen ihren Grund (Reinigung/Toilette) als Pillen-Text.
                reinigungPillLabel: ev.reinigungGrund
                  ? tOpen(GRUND_I18N_KEYS[ev.reinigungGrund as keyof typeof GRUND_I18N_KEYS] ?? "grundReinigung")
                  : null,
                timeCorrected,
                timeCorrectedSystemStr: timeCorrected ? formatDateTime(ev.submittedAt!, dl, tz) : null,
                deviceName: ev.deviceName ?? null,
                showDevice: userHasDevices,
                keyDetected: ev.keyDetected ?? null,
                keyProofSource: ev.keyProofSource ?? null,
                boxImageUrl: ev.boxImageUrl ?? null,
              };
            })}
            sessionStart={sessionStart.toISOString()}
            nowIso={now.toISOString()}
            locale={dl}
            mode="active"
            storageScope="active-plug"
          />
        </Section>
      )}
    </section>
  );
}
