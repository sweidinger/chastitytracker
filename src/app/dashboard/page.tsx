import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  formatDateTime, formatHours,
  buildPairs, interruptionPauseMs, buildKontrolleItems,
  toDateLocale, calculateWearingHoursByRange,
  getMidnightToday, getWeekStart, getMonthStart,
  buildWearSessionRows,
  buildWearPairs, WEAR_PAIR, APP_TZ,
  type ReinigungSettings,
} from "@/lib/utils";
import { proratedVorgabeTargets } from "@/lib/goalFulfillment";
import { buildSessionEvents, buildPlugSessionEvents } from "@/lib/sessionHelpers";
import { buildCategoryWearGoals } from "@/lib/categoryGoals";
import { getActiveVorgabe, getActiveSperrzeit, getActiveWearSessions, getNonKgTrackingCategories, getSessionCategories, getActiveOrgasmusAnforderung, getActivePlugAnforderung, getActivePlugSperrzeit, aktiveKontrolleWhere, activeVerschlussAnforderungWhere } from "@/lib/queries";
import { getActiveSessionsAllCategories } from "@/lib/sessionService";
import { plugCategoryId } from "@/lib/deviceCategories";
import { deviceCategoriesEnabled } from "@/lib/constants";
import { getActivePause } from "@/lib/pauseService";
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
import InactiveCategories from "./InactiveCategories";
import TagesformWidget from "@/app/components/TagesformWidget";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }
  const userId = session.user.id;

  const t = await getTranslations("dashboard");
  const tOrgasm = await getTranslations("orgasmForm");
  const dl = toDateLocale(await getLocale());
  const tz = session.user.timezone ?? APP_TZ;
  const now = new Date();

  // ── Parallel data fetch ──
  const flagOn = deviceCategoriesEnabled();
  const plugCatId = plugCategoryId(userId);
  const [entries, alleAnforderungen, activeVorgabe, offeneVerschlussAnf, activeSperrzeit, userSettings, wearSessions, allNonKgCategories, allSessionCategories, activeSessionSessions, deviceCount, offeneOrgasmusAnf, offenePlugAnf, activePlugSperrzeit, activeCagePause, activePlugPause] = await Promise.all([
    prisma.entry.findMany({
      where: { userId },
      orderBy: { startTime: "desc" },
      include: { device: { select: { categoryId: true, name: true } } },
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
    prisma.user.findUnique({ where: { id: userId }, select: { reinigungErlaubt: true, reinigungMaxMinuten: true, orgasmusArtenConfig: true, oeffnenGruendeConfig: true } }),
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
  ]);
  const userHasDevices = deviceCount > 0;

  const reinigung: ReinigungSettings = {
    erlaubt: userSettings?.reinigungErlaubt ?? false,
    maxMinuten: userSettings?.reinigungMaxMinuten ?? 15,
  };

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
  const activePair = pairs.find((p) => p.active) ?? null;

  const orgasmusEntries = entries
    .filter((e) => e.type === "ORGASMUS")
    .sort((a, b) => b.startTime.getTime() - a.startTime.getTime());

  const orgasmCfg = effectiveOrgasmusArten(userSettings?.orgasmusArtenConfig);
  const rawSessionEvents = activePair
    ? buildSessionEvents(activePair, orgasmusEntries, dl, (art) => resolveOrgasmusArtDisplay(art, orgasmCfg, tOrgasm))
    : [];

  const { tagH, wocheH, monatH, jahrH } = calculateWearingHoursByRange(entries, now, reinigung);

  const wearSessionRows = buildWearSessionRows(allNonKgCategories, entries, now, dl);

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
    } : null,

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
            activeVorgabe={activeVorgabe ? proratedVorgabeTargets(activeVorgabe, now, tz) : null}
            tagH={tagH}
            wocheH={wocheH}
            monatH={monatH}
            jahrH={jahrH}
            tz={tz}
            activeCagePauseSince={activeCagePause?.startTime.toISOString() ?? null}
            deviceName={cageDeviceName}
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
      {flagOn && <CategoryGoalsToday userId={userId} activeWearSessions={wearSessions} />}
      <InactiveCategories
        categories={[
          ...allNonKgCategories
            .filter((c) => !wearSessions.some((s) => s.categoryId === c.id))
            .map((c) => {
              const wearPairs = buildWearPairs(entries, now, { types: WEAR_PAIR, categoryId: c.id });
              const completedPairs = wearPairs.filter(p => p.end.getTime() !== now.getTime());
              const lastEnd = completedPairs.at(-1)?.end ?? null;
              return { ...c, notWornSinceMs: lastEnd ? now.getTime() - lastEnd.getTime() : null };
            }),
          ...allSessionCategories
            .filter((c) => !activeSessionSessions.some((s) => s.categoryId === c.id))
            .map((c) => {
              // Find last SESSION_END for this category to compute pause duration
              const lastSessionEnd = entries
                .filter(e => e.type === "SESSION_END" && e.device?.categoryId === c.id)
                .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())[0] ?? null;
              return {
                ...c,
                notWornSinceMs: lastSessionEnd ? now.getTime() - lastSessionEnd.startTime.getTime() : null,
                isSessionCategory: true as const,
              };
            }),
        ]}
      />
      <div className="w-full max-w-2xl mx-auto px-4 pb-2">
        <TagesformWidget />
      </div>
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
