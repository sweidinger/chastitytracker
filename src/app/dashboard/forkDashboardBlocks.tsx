import { cache } from "react";
import { getTranslations } from "next-intl/server";
import { prisma } from "@/lib/prisma";
import { block, type StackBlock } from "@/lib/blockStack";
import type { SubDashboardBlockId } from "@/lib/dashboardBlockRegistry";
import { activeWearSessionsCached, entriesCached, orgasmEntriesCached } from "@/lib/dashboardData";
import { deviceCategoriesEnabled } from "@/lib/constants";
import { formatDateTime, buildKontrolleItems } from "@/lib/utils";
import { plugCategoryId } from "@/lib/deviceCategories";
import { buildCategoryWearGoals } from "@/lib/categoryGoals";
import { hasVisibleGoalRow } from "@/lib/goalFulfillment";
import { buildPlugSessionEvents } from "@/lib/sessionHelpers";
import { getActivePlugAnforderung, getActivePlugSperrzeit } from "@/lib/queries";
import { getActiveSessionsAllCategories, getAllActiveSessionAnforderungen } from "@/lib/sessionService";
import { getActivePause, pauseBeginCountsToday, buildCagePauseQuota, buildPlugPauseQuota } from "@/lib/pauseService";
import { getOrgasmusBudgetState } from "@/lib/orgasmBudgetService";
import { getBelohnungState } from "@/lib/belohnung";
import { getActiveHealthHold } from "@/lib/healthHoldService";
import LockRequestBanner from "@/app/components/LockRequestBanner";
import DashboardBlock from "@/app/components/DashboardBlock";
import TagesformWidget from "@/app/components/TagesformWidget";
import LaufendePlugSessionCard from "./LaufendePlugSessionCard";
import BelohnungBanner from "./BelohnungBanner";
import DenialCounterCard from "./DenialCounterCard";
import HealthHoldCard from "./HealthHoldCard";
import StrafenBanner from "./StrafenBanner";
import type { SubDashboardCtx } from "./dashboardBlocks";

/**
 * **Fork-Blöcke des Träger-Dashboards** (sweidinger/chastitytracker) — eingehängt in Upstreams
 * Block-System (`dashboardBlocks.tsx`, Register `dashboardBlockRegistry.ts`).
 *
 * Eigene Datei, damit die Fork-Funktionen (Pausen, Plug-Session, Session-Kategorien, Belohnungen,
 * Denial-Zähler, Gesundheits-Stopp, Strafen-Erledigung, Tagesform) beim nächsten Upstream-Merge
 * nicht mitten in Upstreams Blöcken stehen. Die Fork-Ergänzungen an Upstream-Blöcken (KG-Karte,
 * Trage-Sessions, Ziele) lesen ihre Daten über die Helfer unten.
 */

// ── Geteilte Fork-Daten (je Request memoisiert, primitive Schlüssel) ─────────────────────────────

/** Die Pausen-Felder des Trägers — nicht Teil von Upstreams `BLOCK_USER_SELECT`. */
const pauseUserCached = cache((userId: string) =>
  prisma.user.findUnique({
    where: { id: userId },
    select: {
      cleaningAllowed: true, cleaningMaxMinutes: true, cleaningMaxPerDay: true,
      toiletteErlaubt: true, toiletteMaxMinuten: true, toiletteMaxProTag: true,
      plugReinigungErlaubt: true, plugReinigungMaxMinuten: true, plugReinigungMaxProTag: true, plugToiletteMaxMinuten: true,
    },
  }),
);

/** Fork: laufende Cage-Pause + heutiges Rest-Kontingent — für die KG-Karte (`runningSession`). */
export const cagePauseDataCached = cache(async (userId: string, nowMs: number, tz: string) => {
  const [user, active, counts] = await Promise.all([
    pauseUserCached(userId),
    getActivePause(userId, "CAGE"),
    pauseBeginCountsToday(userId, "CAGE", new Date(nowMs), tz),
  ]);
  return {
    activeCagePauseSince: active?.startTime.toISOString() ?? null,
    pauseQuota: user ? buildCagePauseQuota(user, counts) : [],
  };
});

/** Fork: die laufenden Sessions der Session-Kategorien (Start/Ende statt Tragen). */
const activeSessionSessionsCached = cache(async (userId: string) =>
  deviceCategoriesEnabled() ? getActiveSessionsAllCategories(userId) : [],
);

/**
 * Fork: die aktive PLUG-Session samt allem, was ihre grosse Karte braucht — oder `null`.
 *
 * Geteilt, weil drei Blöcke dieselbe Frage stellen: die Karte selbst, die Trage-Sessions (die den
 * Plug dann nicht doppelt zeigen) und die Ziel-Karte (die sein Ziel dann auslässt).
 */
export const plugSessionDataCached = cache(async (userId: string, nowMs: number, tz: string, dl: string) => {
  if (!deviceCategoriesEnabled()) return null;
  const plugCatId = plugCategoryId(userId);
  const session = (await activeWearSessionsCached(userId)).find((s) => s.categoryId === plugCatId) ?? null;
  if (!session) return null;

  const now = new Date(nowMs);
  const [entries, user, activePause, counts, lockPeriod, inspections] = await Promise.all([
    entriesCached(userId),
    pauseUserCached(userId),
    getActivePause(userId, "PLUG"),
    pauseBeginCountsToday(userId, "PLUG", now, tz),
    getActivePlugSperrzeit(userId, plugCatId),
    // Erfüllte Plug-Kontrollen für die Zeitleiste — Fork-Altbestand (`deviceKind: "PLUG"`) UND
    // Upstreams Trage-Kontrolle auf die Plug-Kategorie (`categoryId`).
    prisma.kontrollAnforderung.findMany({
      where: { userId, entryId: { not: null }, OR: [{ deviceKind: "PLUG" }, { categoryId: plugCatId }] },
      orderBy: { createdAt: "desc" },
      include: { entry: true },
    }),
  ]);

  const plugStart = session.since;
  const plugPauses = entries
    .filter((e) => (e.type === "PAUSE_BEGIN" || e.type === "PAUSE_END") && e.pauseDevice === "PLUG" && e.startTime >= plugStart)
    .map((e) => ({ type: e.type, startTime: e.startTime, imageUrl: e.imageUrl, note: e.note, oeffnenGrund: e.oeffnenGrund }));
  // `buildKontrolleItems` nimmt nur KG-Ziele (categoryId null) — hier sind alle bewusst Plug-Kontrollen.
  const plugKontrollItems = buildKontrolleItems(inspections.map((k) => ({ ...k, categoryId: null })), [], now);
  const events = buildPlugSessionEvents(plugStart, plugPauses, plugKontrollItems, dl);

  // Bereits abgeschlossene Pausen-ms (die laufende Pause zählt `PauseAwareDuration` selbst).
  let pausedMs = 0;
  let openBegin: Date | null = null;
  for (const p of [...plugPauses].sort((a, b) => a.startTime.getTime() - b.startTime.getTime())) {
    if (p.type === "PAUSE_BEGIN") openBegin = p.startTime;
    else if (p.type === "PAUSE_END" && openBegin) { pausedMs += p.startTime.getTime() - openBegin.getTime(); openBegin = null; }
  }

  const goalRow = (await buildCategoryWearGoals(userId, now, entries)).find((r) => r.categoryId === plugCatId) ?? null;

  return {
    plugCatId,
    session,
    events,
    pausedMs,
    activePauseSince: activePause?.startTime.toISOString() ?? null,
    pauseQuota: user ? buildPlugPauseQuota(user, counts) : [],
    goalRow,
    lockPeriod,
  };
});

/** Steht die grosse Plug-Karte gerade auf dem Schirm? Gleiches Muster wie `sessionCardOnScreen`. */
export const plugCardOnScreen = async (ctx: SubDashboardCtx): Promise<boolean> =>
  ctx.layout.shows("plugSession") && (await plugSessionDataCached(ctx.userId, ctx.nowMs, ctx.tz, ctx.dl)) !== null;

/**
 * Fork-Zusätze für die Zeilen von `activeWearSessions`: Pause-Knöpfe am
 * Plug (wenn seine grosse Karte NICHT steht) und die Sessions der Session-Kategorien. Ist die
 * Plug-Karte auf dem Schirm, entfällt seine Zeile — sonst stünde er doppelt.
 */
export async function forkWearSessionExtras(ctx: SubDashboardCtx) {
  const [plug, plugOnScreen, sessionSessions] = await Promise.all([
    plugSessionDataCached(ctx.userId, ctx.nowMs, ctx.tz, ctx.dl),
    plugCardOnScreen(ctx),
    activeSessionSessionsCached(ctx.userId),
  ]);
  const plugCatId = deviceCategoriesEnabled() ? plugCategoryId(ctx.userId) : null;
  // Ohne aktive Plug-Session gibt es keine Plug-Zeile — dann braucht es auch keinen Pause-Stand.
  const plugPauseSince = plug?.activePauseSince ?? null;
  return {
    hiddenCategoryId: plugOnScreen ? plugCatId : null,
    // Das Ablege-Ziel normaler Trage-Zeilen bleibt Upstreams `wearActionHref`; nur der Plug bekommt
    // seine Pause-Knöpfe dazu.
    rowExtras: (categoryId: string) => ({
      ...(categoryId === plugCatId ? {
        activePauseSince: plugPauseSince,
        pauseStartHref: "/dashboard/new/pause-start?device=PLUG",
        pauseEndHref: "/dashboard/new/pause-end?device=PLUG",
      } : {}),
    }),
    sessionRows: sessionSessions.map((s) => ({
      categoryId: s.categoryId,
      categoryName: s.categoryName,
      categoryColor: s.categoryColor,
      categoryIcon: s.categoryIcon,
      deviceName: s.deviceName,
      since: s.since.toISOString(),
      heldReason: null,
      imageUrl: null,
      endHref: `/dashboard/new/session-end?category=${s.categoryId}`,
    })),
  };
}

// ── Die Fork-Blöcke ───────────────────────────────────────────────────────────────────────────

/** Die Ids der Fork-Blöcke — Teilmenge von `SubDashboardBlockId`, im Register eingetragen. */
export type ForkSubDashboardBlockId = Extract<SubDashboardBlockId,
  "forkRequests" | "healthHold" | "penaltyTasks" | "plugSession" | "rewards" | "denialCounter" | "dailyForm">;

export const FORK_SUB_DASHBOARD_BLOCK_TABLE: Record<ForkSubDashboardBlockId, StackBlock<SubDashboardCtx>> = {
  // Fork-Anforderungen mit Frist (Plug tragen, Session starten, Plug-Sperrdauer) — direkt unter
  // Upstreams `alerts`, mit denselben Bannern.
  forkRequests: block({
    load: async ({ userId }) => {
      if (!deviceCategoriesEnabled()) return null;
      const plugCatId = plugCategoryId(userId);
      const [plugRequest, plugLockPeriod, sessionRequests] = await Promise.all([
        getActivePlugAnforderung(userId, plugCatId),
        getActivePlugSperrzeit(userId, plugCatId),
        getAllActiveSessionAnforderungen(userId),
      ]);
      if (!plugRequest && !plugLockPeriod && sessionRequests.length === 0) return null;
      return { plugCatId, plugRequest, plugLockPeriod, sessionRequests };
    },
    render: (data, { now, dl, tz, t }) => data && (
      <DashboardBlock className="flex flex-col gap-4">
        {data.plugRequest && (
          <LockRequestBanner
            variant="large"
            colorScheme="request"
            label={t("plugWearRequest")}
            message={data.plugRequest.message}
            deadlineLabel={data.plugRequest.endsAt ? t("plugWearRequestUntil", { date: formatDateTime(data.plugRequest.endsAt, dl, tz) }) : null}
            overdue={!!data.plugRequest.endsAt && data.plugRequest.endsAt < now}
            href={`/dashboard/new/wear-begin?category=${data.plugCatId}&anforderung=${data.plugRequest.id}`}
            actionLabel={t("plugWearRequestAction")}
          />
        )}
        {data.sessionRequests.map((s) => (
          <LockRequestBanner
            key={s.id}
            variant="large"
            colorScheme="request"
            label={t("sessionRequest", { name: s.deviceCategory?.name ?? "?" })}
            message={s.nachricht}
            deadlineLabel={s.endetAt ? t("sessionRequestUntil", { date: formatDateTime(s.endetAt, dl, tz) }) : null}
            overdue={!!s.endetAt && s.endetAt < now}
            href={`/dashboard/new/session-begin?category=${s.deviceCategoryId}`}
            actionLabel={t("sessionRequestAction")}
          />
        ))}
        {data.plugLockPeriod && (
          <LockRequestBanner
            variant="large"
            colorScheme="sperrzeit"
            label={t("plugWearDuration")}
            message={data.plugLockPeriod.message}
            deadlineLabel={data.plugLockPeriod.endsAt ? t("plugWearDurationUntil", { date: formatDateTime(data.plugLockPeriod.endsAt, dl, tz) }) : null}
          />
        )}
      </DashboardBlock>
    ),
  }),

  // Gesundheits-Stopp: aktiv ein ruhiger Banner, sonst ein dezenter Auslöser.
  healthHold: block({
    load: async ({ userId }) => {
      const [hold, tCommon] = await Promise.all([getActiveHealthHold(userId), getTranslations("common")]);
      return { hold, cancelLabel: tCommon("cancel") };
    },
    render: ({ hold, cancelLabel }, { t }) => (
      <HealthHoldCard
        initial={hold ? { reason: hold.reason, since: hold.since.toISOString() } : null}
        labels={{
          activeTitle: t("healthHoldActiveTitle"),
          activeHint: t("healthHoldActiveHint"),
          since: t("healthHoldSince"),
          end: t("healthHoldEnd"),
          trigger: t("healthHoldTrigger"),
          triggerHint: t("healthHoldTriggerHint"),
          reasonLabel: t("healthHoldReasonLabel"),
          reasonPlaceholder: t("healthHoldReasonPlaceholder"),
          submit: t("healthHoldSubmit"),
          cancel: cancelLabel,
        }}
      />
    ),
  }),

  // Offene bzw. zur Prüfung gemeldete Strafen-Aufgaben (Fork-Strafen-Erledigung). Rendert nichts,
  // wenn es keine gibt.
  penaltyTasks: async ({ userId }) => <StrafenBanner userId={userId} />,

  // Die grosse Plug-Karte — direkt unter der KG-Karte.
  plugSession: block({
    load: ({ userId, nowMs, tz, dl }) => plugSessionDataCached(userId, nowMs, tz, dl),
    render: (plug, { now, tz }) => plug && (
      <DashboardBlock>
        <LaufendePlugSessionCard
          sessionStart={plug.session.since}
          interruptionPausedMs={plug.pausedMs}
          now={now}
          events={plug.events}
          categoryName={plug.session.categoryName}
          categoryColor={plug.session.categoryColor}
          categoryIcon={plug.session.categoryIcon}
          deviceName={plug.session.deviceName}
          activePlugPauseSince={plug.activePauseSince}
          goal={plug.goalRow && hasVisibleGoalRow(plug.goalRow.goal.targetH) ? plug.goalRow.goal : null}
          tagH={plug.goalRow?.tagH ?? 0}
          wocheH={plug.goalRow?.wocheH ?? 0}
          monatH={plug.goalRow?.monatH ?? 0}
          jahrH={plug.goalRow?.jahrH ?? 0}
          lockPeriodEndsAt={plug.lockPeriod?.endsAt ?? null}
          lockPeriodIndefinite={!!plug.lockPeriod && plug.lockPeriod.endsAt === null}
          lockPeriodMessage={plug.lockPeriod?.message ?? null}
          tz={tz}
          pauseQuota={plug.pauseQuota}
        />
      </DashboardBlock>
    ),
  }),

  // Belohnungs-Guthaben (verdiente Orgasmen) samt laufendem Belohnungs-Fenster.
  rewards: block({
    load: ({ userId, now }) => getBelohnungState(userId, now),
    render: (state, { t }) => (
      <BelohnungBanner
        available={state.available}
        reserved={state.reserved}
        activeWindowEndetAt={state.activeWindow ? state.activeWindow.endsAt.toISOString() : null}
        oeffnenErlaubt={state.activeWindow?.openingAllowed ?? false}
        labels={{
          title: t("belohnungBannerTitle"),
          available: t("belohnungAvailable"),
          reserved: t("belohnungReserved"),
          windowLabel: t("belohnungWindowLabel"),
          oeffnenAllowed: t("belohnungOeffnenAllowed"),
        }}
      />
    ),
  }),

  // Denial-Zähler (Zeit seit dem letzten Orgasmus, live) mit der Orgasmus-Budget-Zeile.
  denialCounter: block({
    load: async ({ userId, now, tz }) => {
      const [orgasms, budget] = await Promise.all([orgasmEntriesCached(userId), getOrgasmusBudgetState(userId, now, tz)]);
      return { lastOrgasmAt: orgasms[0]?.startTime.toISOString() ?? null, budget };
    },
    render: ({ lastOrgasmAt, budget }, { t }) => (
      <DenialCounterCard
        lastOrgasmAt={lastOrgasmAt}
        budgetLine={budget.limit != null
          ? t("orgasmBudgetLine", {
              used: budget.used,
              limit: budget.limit,
              period: budget.periode === "MONAT" ? t("orgasmBudgetPeriodMonth") : t("orgasmBudgetPeriodWeek"),
              remaining: budget.remaining ?? 0,
            })
          : null}
        labels={{ title: t("denialTitle"), since: t("denialSince"), noneYet: t("denialNoneYet") }}
      />
    ),
  }),

  // Tagesform (Erregung / Körper / Headspace) — lädt und speichert selbst über /api/tagesform.
  dailyForm: async () => (
    <DashboardBlock>
      <TagesformWidget />
    </DashboardBlock>
  ),
};
