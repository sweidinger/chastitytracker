import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  formatDateTime, formatHours,
  buildPairs, getOpenPair, interruptionPauseMs, buildKontrolleItems, runningCleaningPauseUntil,
  toDateLocale, calculateWearingHoursByRange,
  getMidnightToday, getWeekStart, getMonthStart,
  wearingHoursFromPairs, APP_TZ,
  type ReinigungSettings,
} from "@/lib/utils";
import { buildWearSessions, wearHourPairsByCategory } from "@/lib/sessionModel";
import { buildWearSessionRows } from "@/lib/wearSessionRows";
import { proratedVorgabeTargets } from "@/lib/goalFulfillment";
import { buildSessionEvents, buildPlugSessionEvents } from "@/lib/sessionHelpers";
import { buildCategoryWearGoals } from "@/lib/categoryGoals";
import { getActiveVorgabe, getActiveSperrzeit, getActiveWearSessions, getNonKgTrackingCategories, getSessionCategories, getActiveOrgasmusAnforderung, getActivePlugAnforderung, getActivePlugSperrzeit, aktiveKontrolleWhere, activeVerschlussAnforderungWhere, openLockRequestWhere, LOCK_REQUEST_ORDER, cleaningBlockReason } from "@/lib/queries";
import { getActiveSessionsAllCategories, getAllActiveSessionAnforderungen } from "@/lib/sessionService";
import { plugCategoryId } from "@/lib/deviceCategories";
import { deviceCategoriesEnabled, heimdallEnabled } from "@/lib/constants";
import { getActivePause, pauseBeginCountsToday, buildCagePauseQuota, buildPlugPauseQuota } from "@/lib/pauseService";
import { buildReinigungView, reinigungVerbrauchtHeute, nextReinigungsFenster } from "@/lib/reinigungService";
import { buildBoxReinigungView } from "@/lib/boxReinigung";
import { loadTelemetryKeyProof } from "@/lib/boxKeyProof";
import { effectiveOrgasmusArten, resolveReasonLabel, resolveOrgasmusArtDisplay } from "@/lib/reasonsService";
import { getTranslations, getLocale } from "next-intl/server";
import DashboardClient, { type DashboardProps } from "./DashboardClient";
import LaufendeSessionCard from "./LaufendeSessionCard";
import LaufendePlugSessionCard from "./LaufendePlugSessionCard";
import SessionList from "./SessionList";
import WearSessionList from "./WearSessionList";
import ActiveWearSessions from "./ActiveWearSessions";
import CategoriesPromoCard from "./CategoriesPromoCard";
import CategoryGoalsToday from "./CategoryGoalsToday";
import BelohnungBanner from "./BelohnungBanner";
import DenialCounterCard from "./DenialCounterCard";
import { getOrgasmusBudgetState } from "@/lib/orgasmBudgetService";
import HealthHoldCard from "./HealthHoldCard";
import StrafenBanner from "./StrafenBanner";
import { getBelohnungState } from "@/lib/belohnung";
import { getActiveHealthHold } from "@/lib/healthHoldService";
import TimerDisplay from "@/app/components/TimerDisplay";
import { LockOpen, Lock } from "lucide-react";
import Link from "next/link";
import Button from "@/app/components/Button";
import TagesformWidget from "@/app/components/TagesformWidget";
import InactiveCategories from "./InactiveCategories";
import BoxStatusCard from "@/app/components/BoxStatusCard";
import DashboardBlock from "@/app/components/DashboardBlock";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }
  const userId = session.user.id;

  const t = await getTranslations("dashboard");
  const tOrgasm = await getTranslations("orgasmForm");
  const tCommon = await getTranslations("common");
  const dl = toDateLocale(await getLocale());
  const tz = session.user.timezone ?? APP_TZ;
  const now = new Date();
  const healthHold = await getActiveHealthHold(userId);
  const healthHoldLabels = {
    activeTitle: t("healthHoldActiveTitle"),
    activeHint: t("healthHoldActiveHint"),
    since: t("healthHoldSince"),
    end: t("healthHoldEnd"),
    trigger: t("healthHoldTrigger"),
    triggerHint: t("healthHoldTriggerHint"),
    reasonLabel: t("healthHoldReasonLabel"),
    reasonPlaceholder: t("healthHoldReasonPlaceholder"),
    submit: t("healthHoldSubmit"),
    cancel: tCommon("cancel"),
  };
  const belohnungState = await getBelohnungState(userId, now);
  const belohnungBannerLabels = {
    title: t("belohnungBannerTitle"),
    available: t("belohnungAvailable"),
    reserved: t("belohnungReserved"),
    windowLabel: t("belohnungWindowLabel"),
    oeffnenAllowed: t("belohnungOeffnenAllowed"),
  };
  const denialLabels = {
    title: t("denialTitle"),
    since: t("denialSince"),
    noneYet: t("denialNoneYet"),
  };

  // ── Parallel data fetch ──
  const flagOn = deviceCategoriesEnabled();
  const plugCatId = plugCategoryId(userId);
  const [entries, alleAnforderungen, activeVorgabe, offeneVerschlussAnf, activeSperrzeit, userSettings, wearSessions, allNonKgCategories, allSessionCategories, activeSessionSessions, deviceCount, offeneOrgasmusAnf, offenePlugAnf, activePlugSperrzeit, activeCagePause, activePlugPause, cagePauseCounts, plugPauseCounts] = await Promise.all([
    prisma.entry.findMany({
      where: { userId },
      orderBy: { startTime: "desc" },
      include: { device: { select: { id: true, categoryId: true, name: true } } },
    }),
    // Zeitversetzt geplante Kontrollen (wirksamAb in der Zukunft) bleiben für den Sub unsichtbar.
    prisma.kontrollAnforderung.findMany({ where: { userId, ...aktiveKontrolleWhere(now) }, orderBy: { createdAt: "desc" }, include: { entry: true } }),
    getActiveVorgabe(userId, now),
    // Zeitversetzt geplante Anforderungen (wirksamAb in der Zukunft) bleiben für den Sub unsichtbar.
    // KG only (deviceCategoryId = null): bei mehreren offenen zeigt das Sub-Banner die dringendste
    // (LOCK_REQUEST_ORDER) — ein Verschluss erfüllt ohnehin alle. Plug läuft separat über offenePlugAnf.
    prisma.verschlussAnforderung.findFirst({
      where: { ...openLockRequestWhere(userId), deviceCategoryId: null, ...activeVerschlussAnforderungWhere(now) },
      orderBy: LOCK_REQUEST_ORDER,
      include: { device: { select: { name: true } } },
    }),
    getActiveSperrzeit(userId),
    prisma.user.findUnique({ where: { id: userId }, select: { reinigungErlaubt: true, reinigungMaxMinuten: true, reinigungMaxProTag: true, reinigungsFenster: true, toiletteErlaubt: true, toiletteMaxMinuten: true, toiletteMaxProTag: true, plugReinigungErlaubt: true, plugReinigungMaxMinuten: true, plugReinigungMaxProTag: true, plugToiletteMaxMinuten: true, orgasmusArtenConfig: true, oeffnenGruendeConfig: true } }),
    flagOn ? getActiveWearSessions(userId) : Promise.resolve([]),
    flagOn ? getNonKgTrackingCategories(userId) : Promise.resolve([]),
    flagOn ? getSessionCategories(userId) : Promise.resolve([]),
    flagOn ? getActiveSessionsAllCategories(userId) : Promise.resolve([]),
    prisma.device.count({ where: { userId, archivedAt: null } }),
    getActiveOrgasmusAnforderung(userId, now),
    flagOn ? getActivePlugAnforderung(userId, plugCatId) : Promise.resolve(null),
    flagOn ? getActivePlugSperrzeit(userId, plugCatId) : Promise.resolve(null),
    getActivePause(userId, "CAGE"),
    flagOn ? getActivePause(userId, "PLUG") : Promise.resolve(null),
    pauseBeginCountsToday(userId, "CAGE", now, tz),
    flagOn ? pauseBeginCountsToday(userId, "PLUG", now, tz) : Promise.resolve({ REINIGUNG: 0, TOILETTE: 0 }),
  ]);
  const userHasDevices = deviceCount > 0;

  const reinigung: ReinigungSettings = {
    erlaubt: userSettings?.reinigungErlaubt ?? false,
    maxMinuten: userSettings?.reinigungMaxMinuten ?? 15,
  };

  // Heutiges Rest-Kontingent der Cage-Pausen (Reinigung/Toilette) für die laufende Session-Karte.
  // Nur erlaubte Arten; spiegelt die Tageslimit-Durchsetzung in api/entries (PAUSE_BEGIN je Grund).
  const cagePauseQuota = userSettings ? buildCagePauseQuota(userSettings, cagePauseCounts) : [];
  // Analog für die Plug-Session (Plug-Toilette immer/unbegrenzt, Plug-Reinigung nur wenn aktiviert).
  const plugPauseQuota = userSettings ? buildPlugPauseQuota(userSettings, plugPauseCounts) : [];
  // ── Compute derived state ──
  // Aktive (offene) Kontrollen — max. eine je Gerät (neueste), Cage-Legacy (device null) = CAGE.
  const aktiveKontrollen = alleAnforderungen.filter((k) => !k.entryId && !k.withdrawnAt);
  const offeneKontrollenByDevice: { k: (typeof aktiveKontrollen)[number]; device: "CAGE" | "PLUG" }[] = [];
  {
    const seen = new Set<string>();
    for (const k of aktiveKontrollen) {
      const device = k.device === "PLUG" ? "PLUG" as const : "CAGE" as const;
      if (seen.has(device)) continue;
      seen.add(device);
      offeneKontrollenByDevice.push({ k, device });
    }
  }

  const latest = [...entries]
    .filter((e) => ["VERSCHLUSS", "OEFFNEN"].includes(e.type))
    .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())[0] ?? null;

  const currentStatus = latest
    ? { type: latest.type as "VERSCHLUSS" | "OEFFNEN", since: latest.startTime.toISOString() }
    : null;

  // KG-Gerätename der aktiven Verschluss-Session (für die große KG-Karte)
  const cageDeviceName = latest?.type === "VERSCHLUSS" ? (latest.device?.name ?? null) : null;
  // Reinigungspause: der jüngste KG-Eintrag ist eine Reinigungsöffnung, deren Wiederverschluss die
  // Session noch fortführen würde. Ohne diese Ableitung sah der Sub in dieser Zeit „Geöffnet
  // seit …" — nicht von einer wirklich beendeten Session zu unterscheiden (Rückmeldung 15.07.2026).
  //
  // Die Frist kommt aus `runningCleaningPauseUntil` — DERSELBEN Regel, nach der `buildPairs` die
  // Öffnung als blosse Unterbrechung verbucht. Das ist der Kern: der Countdown beantwortet genau
  // die Frage, die der Sub stellt („bleibt das dieselbe Session?"), und kann dem Zeitstrahl
  // darunter gar nicht widersprechen. Die Strafbuch-Frist (`cleaningRelockObligation`) ist eine
  // ANDERE Frist — siehe die Warnung an beiden Funktionen.
  //
  // BEWUSST nur Anzeige: `isLocked`, die Box-Kopplung und jede Statistik bleiben unberührt — die
  // Box IST offen, und ein erzwungenes „verschlossen" bräche das Wiederverschluss-Formular und die
  // Entry-Guards.
  const cleaningPauseUntil = runningCleaningPauseUntil(latest, reinigung, now);

  // ── Build kontroll items for session events ──
  // Cage-Timeline: nur KG-Kontrollen (device CAGE/null) — Plug-Kontrollen erscheinen in der Plug-Karte.
  const kontrollItems = buildKontrolleItems(alleAnforderungen.filter((k) => k.device !== "PLUG"), entries.filter(e => e.type === "PRUEFUNG"), now);
  const pairs = buildPairs(entries, kontrollItems, reinigung);
  const activePair = getOpenPair(pairs);

  const orgasmusEntries = entries
    .filter((e) => e.type === "ORGASMUS")
    .sort((a, b) => b.startTime.getTime() - a.startTime.getTime());
  const lastOrgasmAt = orgasmusEntries[0]?.startTime.toISOString() ?? null;
  const orgasmBudgetState = await getOrgasmusBudgetState(userId, now, tz);
  const orgasmBudgetLine = orgasmBudgetState.limit != null
    ? t("orgasmBudgetLine", {
        used: orgasmBudgetState.used,
        limit: orgasmBudgetState.limit,
        period: orgasmBudgetState.periode === "MONAT" ? t("orgasmBudgetPeriodMonth") : t("orgasmBudgetPeriodWeek"),
        remaining: orgasmBudgetState.remaining ?? 0,
      })
    : null;

  // ── Box-Ableitungen ──
  // Die Reinigungs-Regeln der Box-Karte (Begründung in `buildBoxReinigungView`) zählen ihr
  // Tageskontingent aus den oben geladenen `entries` — ohne DB. Nur der Schlüssel-Nachweis aus der
  // Telemetrie (`boxKeyProof.ts`) fragt noch ab, deshalb hier kein `Promise.all` mehr.
  const boxReinigung = buildBoxReinigungView(userSettings, entries, activeSperrzeit, now, tz);
  const telemetryKeyProof = await loadTelemetryKeyProof(userId, pairs);

  const orgasmCfg = effectiveOrgasmusArten(userSettings?.orgasmusArtenConfig);
  const rawSessionEvents = activePair
    ? buildSessionEvents(activePair, orgasmusEntries, dl, (art) => resolveOrgasmusArtDisplay(art, orgasmCfg, tOrgasm), telemetryKeyProof)
    : [];

  const { tagH, wocheH, monatH, jahrH } = calculateWearingHoursByRange(entries, now, tz);

  // "Offen"-Hero-Karte (Fork): zeigt beim geöffneten Käfig den Seit-Timer.
  const cageOpen = currentStatus?.type === "OEFFNEN";
  // Das KG-Ziel steht während einer Sperre in der grünen Session-Karte (LaufendeSessionCard). Läuft
  // KEINE Sperre, hätte es sonst nirgends Platz — dann zeigen wir es als führende Zeile in der
  // „Trainingsvorgaben"-Karte (dieselbe, die die Kategorie-Ziele trägt), damit der Sub sein KG-Ziel
  // auch im offenen Zustand sieht statt nur beim Verschluss.
  const kgTargets = activeVorgabe ? proratedVorgabeTargets(activeVorgabe, now, tz) : null;
  const showLaufendeSession = !!activePair && rawSessionEvents.length > 0;
  const inlineKgGoal =
    !showLaufendeSession && kgTargets &&
    (kgTargets.minProTagH != null || kgTargets.minProWocheH != null || kgTargets.minProMonatH != null || kgTargets.minProJahrH != null)
      ? {
          tagH, wocheH, monatH, jahrH,
          goalDayH: kgTargets.minProTagH, goalWeekH: kgTargets.minProWocheH,
          goalMonthH: kgTargets.minProMonatH, goalYearH: kgTargets.minProJahrH,
        }
      : null;

  // Die Trage-Sessions EINMAL bauen — Zeilen-Liste und Wanduhr-Stunden je Kategorie leiten sich
  // beide daraus ab (je GERAET gepaart, Ueberlappungen fuer die Stunden verschmolzen).
  const wearSessionList = buildWearSessions(entries, now);
  const wearSessionRows = buildWearSessionRows(allNonKgCategories, wearSessionList, dl, entries);
  const wearPairsByCategory = wearHourPairsByCategory(wearSessionList, now);

  // Offene Session-Anforderungen (von Admin/AI-Keyholderin) → Banner mit „Session starten"-Button.
  const sessionAnforderungen = flagOn ? await getAllActiveSessionAnforderungen(userId) : [];

  // ── Aktive PLUG-Session → große Karte (analog KG) ──
  const activePlugSession = flagOn ? (wearSessions.find((s) => s.categoryId === plugCatId) ?? null) : null;
  let plugCardData: {
    session: typeof activePlugSession & object;
    events: ReturnType<typeof buildPlugSessionEvents>;
    plugPausedMs: number;
    goalRow: Awaited<ReturnType<typeof buildCategoryWearGoals>>[number] | null;
  } | null = null;
  if (activePlugSession) {
    const plugStart = activePlugSession.since;
    const plugPauses = entries
      .filter((e) => (e.type === "PAUSE_BEGIN" || e.type === "PAUSE_END") && e.pauseDevice === "PLUG" && e.startTime >= plugStart)
      .map((e) => ({ type: e.type, startTime: e.startTime, imageUrl: e.imageUrl, note: e.note, oeffnenGrund: e.oeffnenGrund }));
    const plugKontrollItems = buildKontrolleItems(alleAnforderungen.filter((k) => k.device === "PLUG"), [], now);
    const plugEvents = buildPlugSessionEvents(plugStart, plugPauses, plugKontrollItems, dl);
    // Bereits abgeschlossene Pausen-ms (aktive offene Pause zählt PauseAwareTimer separat)
    let plugPausedMs = 0;
    let ob: Date | null = null;
    for (const p of [...plugPauses].sort((a, b) => a.startTime.getTime() - b.startTime.getTime())) {
      if (p.type === "PAUSE_BEGIN") ob = p.startTime;
      else if (p.type === "PAUSE_END" && ob) { plugPausedMs += p.startTime.getTime() - ob.getTime(); ob = null; }
    }
    const goalRows = await buildCategoryWearGoals(userId, now, entries);
    plugCardData = {
      session: activePlugSession,
      events: plugEvents,
      plugPausedMs,
      goalRow: goalRows.find((r) => r.categoryId === plugCatId) ?? null,
    };
  }

  // ── Serialize for client ──
  const offeneKontrollen = offeneKontrollenByDevice.map(({ k, device }) => {
    const code = k.code || null; // "" → null when requireCode=false
    const kommentar = k.kommentar ?? null;
    const params = new URLSearchParams();
    if (code) params.set("code", code);
    if (kommentar) params.set("kommentar", kommentar);
    params.set("device", device);
    return {
      deadline: k.deadline.toISOString(),
      code,
      kommentar,
      overdue: k.deadline < now,
      href: `/dashboard/new/pruefung?${params.toString()}`,
      device,
    };
  });

  const anfOverdue = offeneVerschlussAnf ? (offeneVerschlussAnf.endetAt ? offeneVerschlussAnf.endetAt < now : false) : false;

  const orgasmusVorgabeLabel = offeneOrgasmusAnf?.vorgegebeneArt
    ? resolveReasonLabel(offeneOrgasmusAnf.vorgegebeneArt, orgasmCfg, "orgasm", tOrgasm)
    : null;

  const clientProps: DashboardProps = {
    currentStatus,
    cleaningPauseUntil: cleaningPauseUntil?.toISOString() ?? null,
    hasEntries: entries.length > 0,

    offeneKontrollen,

    offeneVerschlussAnf: offeneVerschlussAnf ? {
      endetAt: offeneVerschlussAnf.endetAt?.toISOString() ?? null,
      nachricht: offeneVerschlussAnf.nachricht,
      overdue: anfOverdue,
      endetAtLabel: offeneVerschlussAnf.endetAt ? t("lockUntil", { date: formatDateTime(offeneVerschlussAnf.endetAt, dl, tz) }) : null,
      deviceName: offeneVerschlussAnf.device?.name ?? null,
    } : null,

    activeSperrzeit: activeSperrzeit ? {
      endetAt: activeSperrzeit.endetAt?.toISOString() ?? null,
      nachricht: activeSperrzeit.nachricht,
      endetAtLabel: activeSperrzeit.endetAt ? t("openingForbiddenUntil", { date: formatDateTime(activeSperrzeit.endetAt, dl, tz) }) : null,
    } : null,

    offenePlugAnf: offenePlugAnf ? {
      id: offenePlugAnf.id,
      endetAt: offenePlugAnf.endetAt?.toISOString() ?? null,
      nachricht: offenePlugAnf.nachricht,
      endetAtLabel: offenePlugAnf.endetAt ? t("plugWearRequestUntil", { date: formatDateTime(offenePlugAnf.endetAt, dl, tz) }) : null,
      categoryId: plugCatId,
      overdue: offenePlugAnf.endetAt ? offenePlugAnf.endetAt < now : false,
    } : null,

    activePlugSperrzeit: activePlugSperrzeit ? {
      endetAt: activePlugSperrzeit.endetAt?.toISOString() ?? null,
      nachricht: activePlugSperrzeit.nachricht,
      endetAtLabel: activePlugSperrzeit.endetAt ? t("plugWearDurationUntil", { date: formatDateTime(activePlugSperrzeit.endetAt, dl, tz) }) : null,
    } : null,

    offeneOrgasmusAnf: offeneOrgasmusAnf ? {
      label: offeneOrgasmusAnf.art === "ANWEISUNG" ? t("orgasmInstructed") : t("orgasmOpportunity"),
      nachricht: [orgasmusVorgabeLabel ? t("orgasmRequiredArt", { art: orgasmusVorgabeLabel }) : null, offeneOrgasmusAnf.nachricht].filter(Boolean).join(" · ") || null,
      windowLabel: t("orgasmWindowFromUntil", { from: formatDateTime(offeneOrgasmusAnf.beginntAt, dl, tz), until: formatDateTime(offeneOrgasmusAnf.endetAt, dl, tz) }),
      overdue: offeneOrgasmusAnf.endetAt < now,
      vorgegebeneArt: offeneOrgasmusAnf.vorgegebeneArt ?? null,
    } : null,

    sessionAnforderungen: sessionAnforderungen.map((s) => ({
      categoryId: s.deviceCategoryId,
      categoryName: s.deviceCategory?.name ?? "?",
      nachricht: s.nachricht,
      endetAtLabel: s.endetAt ? t("sessionRequestUntil", { date: formatDateTime(s.endetAt, dl, tz) }) : null,
      overdue: s.endetAt ? s.endetAt < now : false,
    })),

    tagH,
    wocheH,
    monatH,
    serverNow: now.toISOString(),
    elapsedTagH: (now.getTime() - getMidnightToday(now, tz).getTime()) / 3_600_000,
    elapsedWocheH: (now.getTime() - getWeekStart(now, tz).getTime()) / 3_600_000,
    elapsedMonatH: (now.getTime() - getMonthStart(now, tz).getTime()) / 3_600_000,
  };

  const username = session.user.name ?? "";

  return (
    // Der Abstand zwischen den Blöcken kommt AUSSCHLIESSLICH von diesem `gap-4`, nie aus pt-/pb- der
    // Blöcke selbst — Begründung in `DashboardBlock`.
    <div className="flex flex-col gap-4 py-6">
      <DashboardBlock>
        <h1 className="text-xl font-bold text-foreground">{t("userTitle", { name: username })}</h1>
      </DashboardBlock>
      <HealthHoldCard
        initial={healthHold ? { reason: healthHold.reason, since: healthHold.since.toISOString() } : null}
        labels={healthHoldLabels}
      />
      <BelohnungBanner
        available={belohnungState.available}
        reserved={belohnungState.reserved}
        activeWindowEndetAt={belohnungState.activeWindow ? belohnungState.activeWindow.endetAt.toISOString() : null}
        oeffnenErlaubt={belohnungState.activeWindow?.oeffnenErlaubt ?? false}
        labels={belohnungBannerLabels}
      />
      <DenialCounterCard lastOrgasmAt={lastOrgasmAt} budgetLine={orgasmBudgetLine} labels={denialLabels} />
      <StrafenBanner userId={userId} />
      {cageOpen && currentStatus && (
        <div className="w-full max-w-2xl mx-auto px-4 pt-4">
          <div className="rounded-2xl overflow-hidden border border-unlock-border">
            <div className="px-5 py-4 text-white bg-gradient-to-br from-sky-600 to-sky-500">
              <div className="flex items-center gap-4">
                <div className="w-14 h-14 rounded-xl flex items-center justify-center flex-shrink-0 bg-white/10">
                  <LockOpen size={28} strokeWidth={2} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-widest opacity-60">
                    {cleaningPauseUntil ? t("cleaningPauseLabel") : `${t("openSince")} · ${t("deviceLabelCage")}`}
                  </p>
                  {cleaningPauseUntil ? (
                    <TimerDisplay targetDate={cleaningPauseUntil} mode="countdown" format="short" className="!text-white text-2xl font-bold" />
                  ) : (
                    <TimerDisplay targetDate={currentStatus.since} mode="countup" format="long" className="!text-white text-2xl font-bold" />
                  )}
                </div>
              </div>
              {cleaningPauseUntil && (
                <Link href="/dashboard/new/verschluss" className="mt-4 block">
                  <Button variant="semantic" semantic="lock" fullWidth icon={<Lock size={16} />}>
                    {t("cleaningPauseRelock")}
                  </Button>
                </Link>
              )}
            </div>
          </div>
        </div>
      )}
      {heimdallEnabled() && <BoxStatusCard tz={tz} reinigung={boxReinigung} />}
      {showLaufendeSession && (
        <DashboardBlock>
          <LaufendeSessionCard
            sessionStart={activePair.verschluss.startTime}
            interruptionPausedMs={interruptionPauseMs(activePair.interruptions)}
            now={now}
            events={rawSessionEvents}
            sperrzeitEndetAt={activeSperrzeit?.endetAt ?? null}
            sperrzeitUnbefristet={!!activeSperrzeit && activeSperrzeit.endetAt === null}
            sperrzeitNachricht={activeSperrzeit?.nachricht ?? null}
            // Sub-Sicht: nur wenn er grundsätzlich reinigen darf. Sonst verspräche die Zeile etwas,
            // das seine Benutzer-Einstellung ohnehin verbietet.
            cleaningNote={
              activeSperrzeit && userSettings?.reinigungErlaubt
                ? t(activeSperrzeit.reinigungErlaubt ? "cleaningNoteAllowed" : "cleaningNoteForbidden")
                : null
            }
            keyInBox={activePair.verschluss.keyInBox ?? null}
            activeVorgabe={activeVorgabe ? proratedVorgabeTargets(activeVorgabe, now, tz) : null}
            tagH={tagH}
            wocheH={wocheH}
            monatH={monatH}
            jahrH={jahrH}
            tz={tz}
            activeCagePauseSince={activeCagePause?.startTime.toISOString() ?? null}
            deviceName={cageDeviceName}
            pauseQuota={cagePauseQuota}
          />
        </DashboardBlock>
      )}
      {plugCardData && (
        <DashboardBlock>
          <LaufendePlugSessionCard
            sessionStart={plugCardData.session.since}
            interruptionPausedMs={plugCardData.plugPausedMs}
            now={now}
            events={plugCardData.events}
            categoryName={plugCardData.session.categoryName}
            categoryColor={plugCardData.session.categoryColor}
            categoryIcon={plugCardData.session.categoryIcon}
            deviceName={plugCardData.session.deviceName}
            activePlugPauseSince={activePlugPause?.startTime.toISOString() ?? null}
            goal={plugCardData.goalRow ? {
              minProTagH: plugCardData.goalRow.goalDayH,
              minProWocheH: plugCardData.goalRow.goalWeekH,
              minProMonatH: plugCardData.goalRow.goalMonthH,
              minProJahrH: plugCardData.goalRow.goalYearH,
            } : null}
            tagH={plugCardData.goalRow?.tagH ?? 0}
            wocheH={plugCardData.goalRow?.wocheH ?? 0}
            monatH={plugCardData.goalRow?.monatH ?? 0}
            jahrH={plugCardData.goalRow?.jahrH ?? 0}
            sperrzeitEndetAt={activePlugSperrzeit?.endetAt ?? null}
            sperrzeitUnbefristet={!!activePlugSperrzeit && activePlugSperrzeit.endetAt === null}
            sperrzeitNachricht={activePlugSperrzeit?.nachricht ?? null}
            tz={tz}
            pauseQuota={plugPauseQuota}
          />
        </DashboardBlock>
      )}
      <ActiveWearSessions
        sessions={[
          ...wearSessions.filter((s) => !(plugCardData && s.categoryId === plugCatId)).map((s) => {
            const isPlug = s.categoryId === plugCatId;
            return {
              categoryId: s.categoryId,
              categoryName: s.categoryName,
              categoryColor: s.categoryColor,
              categoryIcon: s.categoryIcon,
              deviceName: s.deviceName,
              since: s.since.toISOString(),
              imageUrl: s.imageUrl,
              endHref: `/dashboard/new/wear-end?category=${s.categoryId}`,
              ...(isPlug ? {
                activePauseSince: activePlugPause?.startTime.toISOString() ?? null,
                pauseStartHref: "/dashboard/new/pause-start?device=PLUG",
                pauseEndHref: "/dashboard/new/pause-end?device=PLUG",
              } : {}),
            };
          }),
          ...activeSessionSessions.map((s) => ({
            categoryId: s.categoryId,
            categoryName: s.categoryName,
            categoryColor: s.categoryColor,
            categoryIcon: s.categoryIcon,
            deviceName: s.deviceName,
            since: s.since.toISOString(),
            imageUrl: null,
            endHref: `/dashboard/new/session-end?category=${s.categoryId}`,
          })),
        ]}
        serverNow={now.toISOString()}
      />
      {flagOn && <CategoriesPromoCard show={allNonKgCategories.length === 0} />}
      {flagOn && <CategoryGoalsToday userId={userId} activeWearSessions={wearSessions} excludeCategoryIds={plugCardData ? [plugCatId] : []} />}
      <div className="w-full max-w-2xl mx-auto px-4 pb-2">
        <TagesformWidget />
      </div>
      {/* KG-Ziel (inlineKgGoal) + Kategorie-Ziele: ungated, damit das KG-Ziel auch bei deaktivierter
          Kategorie-Funktion erscheint. CategoryGoalsToday rendert nichts, wenn weder KG-Ziel noch Zeilen. */}
      <CategoryGoalsToday
        userId={userId}
        activeWearSessions={wearSessions}
        entries={entries}
        includeCategories={flagOn}
        kgGoal={inlineKgGoal}
      />
      <InactiveCategories
        categories={allNonKgCategories
          .filter((c) => !wearSessions.some((s) => s.categoryId === c.id))
          .map((c) => ({
            ...c,
            todayHours: wearingHoursFromPairs(
              wearPairsByCategory.get(c.id) ?? [],
              getMidnightToday(now, tz),
              now,
            ),
          }))}
      />
      <DashboardClient {...clientProps} tz={tz} />
      {pairs.length > 0 && (
        <DashboardBlock>
          <SessionList pairs={pairs} orgasmusEntries={orgasmusEntries} userHasDevices={userHasDevices} tz={tz} orgasmusArtenConfig={userSettings?.orgasmusArtenConfig} oeffnenGruendeConfig={userSettings?.oeffnenGruendeConfig} telemetryKeyProof={telemetryKeyProof} />
        </DashboardBlock>
      )}
      {wearSessionRows.length > 0 && (
        <DashboardBlock>
          <WearSessionList sessions={wearSessionRows} />
        </DashboardBlock>
      )}
    </div>
  );
}
