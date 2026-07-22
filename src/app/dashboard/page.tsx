import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  formatDateTime, formatHours,
  buildPairs, getOpenPair, interruptionPauseMs, buildKontrolleItems,
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
import { getActiveVorgabe, getActiveSperrzeit, getActiveWearSessions, getNonKgTrackingCategories, getSessionCategories, getActiveOrgasmusAnforderung, getActivePlugAnforderung, getActivePlugSperrzeit, aktiveKontrolleWhere, activeVerschlussAnforderungWhere, cleaningBlockReason } from "@/lib/queries";
import { getActiveSessionsAllCategories, getAllActiveSessionAnforderungen } from "@/lib/sessionService";
import { plugCategoryId } from "@/lib/deviceCategories";
import { deviceCategoriesEnabled, heimdallEnabled } from "@/lib/constants";
import { getActivePause, pauseBeginCountsToday, buildCagePauseQuota, buildPlugPauseQuota } from "@/lib/pauseService";
import { buildReinigungView, reinigungVerbrauchtHeute, nextReinigungsFenster } from "@/lib/reinigungService";
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
import CategoryGoalsLive from "./CategoryGoalsLive";
import BelohnungBanner from "./BelohnungBanner";
import HealthHoldCard from "./HealthHoldCard";
import StrafenBanner from "./StrafenBanner";
import { getBelohnungState } from "@/lib/belohnung";
import { getActiveHealthHold } from "@/lib/healthHoldService";
import TimerDisplay from "@/app/components/TimerDisplay";
import { LockOpen } from "lucide-react";
import TagesformWidget from "@/app/components/TagesformWidget";
import InactiveCategories from "./InactiveCategories";
import BoxStatusCard from "@/app/components/BoxStatusCard";

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
    // KG only: deviceCategoryId = null
    prisma.verschlussAnforderung.findFirst({
      where: { userId, art: "ANFORDERUNG", deviceCategoryId: null, fulfilledAt: null, withdrawnAt: null, ...activeVerschlussAnforderungWhere(now) },
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

  // Reinigungs-Regeln für die Box-Karte: einmal je Seitenaufbau, nicht im 5s-Poll. Dieselbe Quelle
  // wie `get_context.cleaning` im MCP — der Sub sah die Fenster bisher nirgends. `blockedBy` kommt
  // aus derselben Regel wie die Durchsetzung und kennt als einziges die AKTIVE Sperrzeit: ohne es
  // versprach die Karte Fenster, die eine reinigungsverbietende Sperre längst gesperrt hatte.
  const jetzt = new Date();
  const boxReinigung = heimdallEnabled() && userSettings
    ? {
        ...buildReinigungView(userSettings, await reinigungVerbrauchtHeute(userId, jetzt, tz), jetzt, tz),
        nextWindow: nextReinigungsFenster(userSettings.reinigungsFenster, jetzt, tz),
        blockedBy: cleaningBlockReason(
          { reinigungErlaubt: userSettings.reinigungErlaubt, reinigungsFenster: userSettings.reinigungsFenster, timezone: tz },
          activeSperrzeit ? [activeSperrzeit] : [],
          jetzt,
        ),
      }
    : null;

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

  // ── Build kontroll items for session events ──
  // Cage-Timeline: nur KG-Kontrollen (device CAGE/null) — Plug-Kontrollen erscheinen in der Plug-Karte.
  const kontrollItems = buildKontrolleItems(alleAnforderungen.filter((k) => k.device !== "PLUG"), entries.filter(e => e.type === "PRUEFUNG"), now);
  const pairs = buildPairs(entries, kontrollItems, reinigung);
  const activePair = getOpenPair(pairs);

  const orgasmusEntries = entries
    .filter((e) => e.type === "ORGASMUS")
    .sort((a, b) => b.startTime.getTime() - a.startTime.getTime());

  const orgasmCfg = effectiveOrgasmusArten(userSettings?.orgasmusArtenConfig);
  const rawSessionEvents = activePair
    ? buildSessionEvents(activePair, orgasmusEntries, dl, (art) => resolveOrgasmusArtDisplay(art, orgasmCfg, tOrgasm))
    : [];

  const { tagH, wocheH, monatH, jahrH } = calculateWearingHoursByRange(entries, now);

  // Cage offen -> separate Trainingsvorgabe-Box (gleicher Stil wie Kategorie-Ziele), nur im offenen Zustand.
  const cageOpen = currentStatus?.type === "OEFFNEN";
  const cageProrated = activeVorgabe ? proratedVorgabeTargets(activeVorgabe, now, tz) : null;
  const cageHasGoal = !!cageProrated && (cageProrated.minProTagH != null || cageProrated.minProWocheH != null || cageProrated.minProMonatH != null || cageProrated.minProJahrH != null);
  const cageGoalRow = (cageOpen && cageHasGoal && cageProrated) ? {
    categoryId: "kg",
    name: t("deviceLabelCage"),
    color: "cat-steel",
    icon: "Lock",
    tagH, wocheH, monatH, jahrH,
    goalDayH: cageProrated.minProTagH,
    goalWeekH: cageProrated.minProWocheH,
    goalMonthH: cageProrated.minProMonatH,
    goalYearH: cageProrated.minProJahrH,
    active: false,
  } : null;

  // Die Trage-Sessions EINMAL bauen — Zeilen-Liste und Wanduhr-Stunden je Kategorie leiten sich
  // beide daraus ab (je GERAET gepaart, Ueberlappungen fuer die Stunden verschmolzen).
  const wearSessionList = buildWearSessions(entries, now);
  const wearSessionRows = buildWearSessionRows(allNonKgCategories, wearSessionList, dl);
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
    <>
      <div className="w-full max-w-2xl mx-auto px-4 pt-6">
        <h1 className="text-xl font-bold text-foreground">{t("userTitle", { name: username })}</h1>
      </div>
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
                    {t("openSince")} · {t("deviceLabelCage")}
                  </p>
                  <TimerDisplay targetDate={currentStatus.since} mode="countup" format="long" className="!text-white text-2xl font-bold" />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      {cageGoalRow && (
        <CategoryGoalsLive rows={[cageGoalRow]} serverNow={now.toISOString()} />
      )}
      {heimdallEnabled() && <BoxStatusCard tz={tz} reinigung={boxReinigung} />}
      {activePair && rawSessionEvents.length > 0 && (
        <div className="w-full max-w-2xl mx-auto px-4 pt-6 pb-2">
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
        </div>
      )}
      {plugCardData && (
        <div className="w-full max-w-2xl mx-auto px-4 pt-2 pb-2">
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
        </div>
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
      {flagOn && <CategoryGoalsToday userId={userId} activeWearSessions={wearSessions} entries={entries} />}
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
        <div className="w-full max-w-2xl mx-auto px-4 pb-6">
          <SessionList pairs={pairs} orgasmusEntries={orgasmusEntries} userHasDevices={userHasDevices} tz={tz} orgasmusArtenConfig={userSettings?.orgasmusArtenConfig} oeffnenGruendeConfig={userSettings?.oeffnenGruendeConfig} />
        </div>
      )}
      {wearSessionRows.length > 0 && (
        <div className="w-full max-w-2xl mx-auto px-4 pb-6">
          <WearSessionList sessions={wearSessionRows} />
        </div>
      )}
    </>
  );
}
