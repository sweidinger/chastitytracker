import { prisma } from "@/lib/prisma";
import type { ServiceResult } from "@/lib/serviceResult";
import { getUserTimezone } from "@/lib/queries";
import { isKgVorgabe } from "@/lib/vorgaben";
import { proratedVorgabeTargets, type GoalPeriod } from "@/lib/goalFulfillment";
import { createOrgasmusAnforderung } from "@/lib/orgasmusAnforderungService";
import { notifyUser } from "@/lib/notify";

/** Kompakte Leitlinie zur Belohnungs-Ökonomie — geteilt vom AI-Kontext (analog zu SEVERITY_GUIDANCE_TEXT). */
export const REWARD_GUIDANCE_TEXT = [
  "",
  "--- Belohnungs-Ökonomie (Orientierung) ---",
  "Der Sub verdient sich Belohnungen, indem er Trainingsziele erreicht. Der Status zeigt dir `belohnung`:",
  "`available` = verfügbares Guthaben, `reserved` = bereits vorgemerkte (offene) Belohnungs-Fenster, `rewardableGoals` = erreichte, noch NICHT gutgeschriebene Ziele.",
  "- Sind unter `rewardableGoals` erreichte Ziele gelistet, schreibe sie mit `credit_reward` gut (bestätigt den Erfolg des Subs). Standard: 1 pro Aufruf.",
  "- Bei available ≥ 1 kannst du mit `grant_reward` ein Belohnungs-Fenster öffnen (der Sub darf sich einen Orgasmus als Belohnung nehmen). Nutze das als positive Verstärkung, nicht zu inflationär.",
  "- Belohnungen sind das Gegenstück zu Strafen: setze sie bewusst ein, wenn der Sub Ziele erfüllt oder sich besonders bemüht.",
  "- `deny_orgasm` (Guthaben −1) und `delay_orgasm` (Fenster verschieben) sind STRAFEN auf der Belohnungsseite — nur bei Vergehen.",
].join("\n");
import {
  buildWearPairs, wearingHoursFromPairs, WEAR_PAIR,
  getMidnightToday, getWeekStart, getMonthStart, getYearStart, tzDateParts,
} from "@/lib/utils";

/**
 * Belohnungs-Ökonomie (Deploy 2). Verdiente Orgasmen als Guthaben: erreicht der Sub ein Trainingsziel
 * (Tag/Woche/Monat/Jahr, KG oder Kategorie), kann die Keyholderin 1 gutschreiben (einmal pro Zeitraum
 * je Ziel — Dedupe via OrgasmusBelohnungGutschrift). Einlösen = ein Belohnungs-Fenster gewähren
 * (OrgasmusAnforderung GELEGENHEIT, istBelohnung, vorgegebeneArt="Belohnung") → 1 wird vorgemerkt
 * (Guthaben −1). Der Sub erfasst einen Orgasmus der Art "Belohnung" im Fenster → erfüllt (bestehendes
 * Matching in /api/entries). Straf-Seite: Entzug (Guthaben −1) und Verzug (Fenster verschieben).
 */

export const BELOHNUNG_ART = "Belohnung";
const DEFAULT_WINDOW_H = 24;

/** Ereignis-Typen des Belohnungs-Kontoauszugs (siehe BelohnungEvent im Schema). */
export type BelohnungEventType =
  | "VERDIENT"    // +1 — erreichtes Trainingsziel gutgeschrieben
  | "GEWAEHRT"    // −1 — Belohnungs-Fenster geöffnet (Guthaben vorgemerkt)
  | "EINGELOEST"  //  0 — Orgasmus im Belohnungs-Fenster erfasst
  | "VERFALLEN"   //  0 — Fenster ungenutzt abgelaufen (netto −1 bleibt)
  | "ENTZOGEN"    // −1 — Strafe: Guthaben entzogen
  | "VERSCHOBEN"; //  0 — Strafe: Fenster nach hinten geschoben

/** Schreibt einen Eintrag in den Belohnungs-Kontoauszug. Fehler hier dürfen die Aktion nie kippen. */
export async function logBelohnungEvent(
  userId: string,
  type: BelohnungEventType,
  delta: number,
  balanceAfter: number,
  detail?: string | null,
): Promise<void> {
  try {
    await prisma.belohnungEvent.create({ data: { userId, type, delta, balanceAfter, detail: detail?.trim() || null } });
  } catch {
    // Protokoll ist Beiwerk — niemals die eigentliche Buchung scheitern lassen.
  }
}

/** Aktuelles Guthaben (für Kontostand-Protokollierung ohne eigene Buchung). */
async function currentBalance(userId: string): Promise<number> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { verdienteOrgasmen: true } });
  return u?.verdienteOrgasmen ?? 0;
}

/** Ein erreichtes, noch nicht gutgeschriebenes Trainingsziel. */
export interface BelohnbarZiel {
  categoryId: string | null; // null = KG
  categoryName: string;
  periodType: GoalPeriod;
  periodKey: string;
  istH: number;
  sollH: number;
}

/** Aktueller Belohnungs-Stand eines Subs. */
export interface BelohnungState {
  available: number; // verfügbares Guthaben (verdienteOrgasmen)
  reserved: number;  // vorgemerkt = offene aktive Belohnungs-Fenster
  activeWindow: { id: string; beginntAt: Date; endetAt: Date; oeffnenErlaubt: boolean } | null;
}

const PERIOD_CONFIG: { period: GoalPeriod; soll: keyof ReturnType<typeof proratedVorgabeTargets>; start: (now: Date, tz: string) => Date }[] = [
  { period: "day", soll: "minProTagH", start: getMidnightToday },
  { period: "week", soll: "minProWocheH", start: getWeekStart },
  { period: "month", soll: "minProMonatH", start: getMonthStart },
  { period: "year", soll: "minProJahrH", start: getYearStart },
];

const pad = (n: number) => String(n).padStart(2, "0");

/** Stabiler Perioden-Schlüssel in User-Zeitzone (aus dem Perioden-Start). */
function periodKeyFor(period: GoalPeriod, now: Date, tz: string): string {
  const start = PERIOD_CONFIG.find((p) => p.period === period)!.start(now, tz);
  const { year, month, day } = tzDateParts(start, tz);
  switch (period) {
    case "day": return `${year}-${pad(month)}-${pad(day)}`;
    case "week": return `W:${year}-${pad(month)}-${pad(day)}`;
    case "month": return `${year}-${pad(month)}`;
    case "year": return `${year}`;
  }
}

const PERIOD_LABEL: Record<string, string> = { day: "Tag", week: "Woche", month: "Monat", year: "Jahr" };

const dedupeKey = (categoryId: string | null, periodType: string, periodKey: string) =>
  `${categoryId ?? ""}|${periodType}|${periodKey}`;

/** Erreichte, noch nicht gutgeschriebene Trainingsziele (KG + Kategorien × Tag/Woche/Monat/Jahr). */
export async function computeBelohnbar(userId: string, now: Date = new Date()): Promise<BelohnbarZiel[]> {
  const tz = await getUserTimezone(userId);
  const [vorgaben, entries, gutschriften] = await Promise.all([
    prisma.trainingVorgabe.findMany({
      where: { userId, gueltigAb: { lte: now }, OR: [{ gueltigBis: null }, { gueltigBis: { gte: now } }] },
      include: { category: { select: { name: true, isBuiltIn: true } } },
    }),
    prisma.entry.findMany({
      where: { userId, type: { in: ["VERSCHLUSS", "OEFFNEN", "WEAR_BEGIN", "WEAR_END"] } },
      orderBy: { startTime: "asc" },
      select: { type: true, startTime: true, device: { select: { categoryId: true } } },
    }),
    prisma.orgasmusBelohnungGutschrift.findMany({ where: { userId } }),
  ]);

  const already = new Set(gutschriften.map((g) => dedupeKey(g.categoryId, g.periodType, g.periodKey)));
  const seen = new Set<string>();
  const result: BelohnbarZiel[] = [];

  for (const v of vorgaben) {
    const kg = isKgVorgabe(v);
    const categoryId = kg ? null : v.categoryId;
    const categoryName = kg ? "KG" : v.category?.name ?? "?";
    const pairs = kg ? buildWearPairs(entries, now) : buildWearPairs(entries, now, { types: WEAR_PAIR, categoryId: v.categoryId! });
    const targets = proratedVorgabeTargets(v, now, tz);
    for (const cfg of PERIOD_CONFIG) {
      const sollH = targets[cfg.soll];
      if (sollH == null || sollH <= 0) continue;
      const periodKey = periodKeyFor(cfg.period, now, tz);
      const dk = dedupeKey(categoryId, cfg.period, periodKey);
      if (already.has(dk) || seen.has(dk)) continue;
      const istH = wearingHoursFromPairs(pairs, cfg.start(now, tz), now);
      if (istH + 1e-9 < sollH) continue; // Ziel nicht erreicht
      seen.add(dk);
      result.push({ categoryId, categoryName, periodType: cfg.period, periodKey, istH, sollH });
    }
  }
  return result;
}

/** Schreibt +1 Guthaben für ein erreichtes Ziel gut (Dedupe pro Zeitraum je Ziel). */
export async function grantGutschrift(
  userId: string,
  categoryId: string | null,
  periodType: string,
  periodKey: string,
): Promise<ServiceResult<{ available: number }>> {
  // Nur gutschreiben, wenn das Ziel aktuell tatsächlich erreicht & offen ist.
  const belohnbar = await computeBelohnbar(userId);
  const match = belohnbar.find(
    (b) => (b.categoryId ?? null) === (categoryId ?? null) && b.periodType === periodType && b.periodKey === periodKey,
  );
  if (!match) return { ok: false, status: 400, error: "Ziel nicht (mehr) belohnbar oder bereits gutgeschrieben" };
  try {
    const [, user] = await prisma.$transaction([
      prisma.orgasmusBelohnungGutschrift.create({ data: { userId, categoryId, periodType, periodKey } }),
      prisma.user.update({ where: { id: userId }, data: { verdienteOrgasmen: { increment: 1 } }, select: { verdienteOrgasmen: true } }),
    ]);
    await logBelohnungEvent(userId, "VERDIENT", 1, user.verdienteOrgasmen, `${match.categoryName} · ${PERIOD_LABEL[match.periodType]} ${match.periodKey}`);
    await notifyUser(userId, {
      subject: "Belohnung verdient",
      message: `Du hast ein Trainingsziel erreicht (${match.categoryName}) — dir wurde 1 Belohnung gutgeschrieben. Verfügbares Guthaben: ${user.verdienteOrgasmen}.`,
    });
    return { ok: true, data: { available: user.verdienteOrgasmen } };
  } catch {
    return { ok: false, status: 409, error: "Bereits gutgeschrieben" };
  }
}

/** Aktuelles offenes Belohnungs-Fenster (vorgemerkt, noch nicht abgelaufen). */
async function activeRewardWindow(userId: string, now: Date) {
  return prisma.orgasmusAnforderung.findFirst({
    where: { userId, istBelohnung: true, fulfilledAt: null, withdrawnAt: null, endetAt: { gt: now } },
    orderBy: { createdAt: "desc" },
  });
}

/** Belohnungs-Stand: verfügbar / vorgemerkt / aktives Fenster. */
export async function getBelohnungState(userId: string, now: Date = new Date()): Promise<BelohnungState> {
  // Aufräumen: abgelaufene, ungenutzte Belohnungs-Fenster als zurückgezogen markieren (das Guthaben
  // wurde beim Gewähren bereits abgebucht — netto −1 bleibt, „Pech gehabt"). Rein kosmetisch.
  const expired = await prisma.orgasmusAnforderung.findMany({
    where: { userId, istBelohnung: true, fulfilledAt: null, withdrawnAt: null, endetAt: { lt: now } },
    select: { id: true, endetAt: true },
  });
  if (expired.length > 0) {
    await prisma.orgasmusAnforderung.updateMany({
      where: { id: { in: expired.map((e) => e.id) } },
      data: { withdrawnAt: now },
    });
    const bal = await currentBalance(userId);
    for (const e of expired) {
      await logBelohnungEvent(userId, "VERFALLEN", 0, bal, `Fenster ungenutzt abgelaufen (${e.endetAt.toISOString()})`);
    }
  }
  const [user, windows] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { verdienteOrgasmen: true } }),
    prisma.orgasmusAnforderung.findMany({
      where: { userId, istBelohnung: true, fulfilledAt: null, withdrawnAt: null, endetAt: { gt: now } },
      orderBy: { createdAt: "desc" },
      select: { id: true, beginntAt: true, endetAt: true, oeffnenErlaubt: true },
    }),
  ]);
  return {
    available: user?.verdienteOrgasmen ?? 0,
    reserved: windows.length,
    activeWindow: windows[0] ?? null,
  };
}

/** Gewährt ein Belohnungs-Fenster: merkt 1 Guthaben vor (Guthaben −1, ≥1 nötig, kein aktives Fenster).
 *  `opts.beginntAt`/`opts.endetAt` erlauben ein explizites Fenster (sonst jetzt + windowHours). */
export async function grantBelohnung(
  userId: string,
  windowHours?: number,
  oeffnenErlaubt: boolean = true,
  opts?: { beginntAt?: Date; endetAt?: Date; nachricht?: string; fotoPflicht?: boolean },
): Promise<ServiceResult<{ id: string; available: number }>> {
  const now = new Date();
  const existing = await activeRewardWindow(userId, now);
  if (existing) return { ok: false, status: 400, error: "Es läuft bereits ein Belohnungs-Fenster." };
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { verdienteOrgasmen: true } });
  if (!user) return { ok: false, status: 404, error: "User nicht gefunden" };
  if (user.verdienteOrgasmen < 1) return { ok: false, status: 400, error: "Kein Guthaben verfügbar." };

  const windowH = windowHours && windowHours > 0 ? windowHours : DEFAULT_WINDOW_H;
  const beginntAt = opts?.beginntAt ?? now;
  const endetAt = opts?.endetAt ?? new Date(now.getTime() + windowH * 60 * 60 * 1000);
  const res = await createOrgasmusAnforderung({
    userId, art: "GELEGENHEIT", istBelohnung: true, vorgegebeneArt: BELOHNUNG_ART, oeffnenErlaubt,
    fotoPflicht: opts?.fotoPflicht,
    beginntAt, endetAt,
    nachricht: opts?.nachricht?.trim() || "Belohnung: Orgasmus-Gelegenheit",
  });
  if (!res.ok) return res;
  const updated = await prisma.user.update({
    where: { id: userId }, data: { verdienteOrgasmen: { decrement: 1 } }, select: { verdienteOrgasmen: true },
  });
  await logBelohnungEvent(userId, "GEWAEHRT", -1, updated.verdienteOrgasmen, `Fenster bis ${endetAt.toISOString()}`);
  return { ok: true, data: { id: res.data.id, available: updated.verdienteOrgasmen } };
}

/** Entzug (Strafe): Guthaben −1. Bei Stand 0 nicht möglich. */
export async function denyReward(userId: string): Promise<ServiceResult<{ available: number }>> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { verdienteOrgasmen: true } });
  if (!user) return { ok: false, status: 404, error: "User nicht gefunden" };
  if (user.verdienteOrgasmen < 1) return { ok: false, status: 400, error: "Kein Guthaben zum Entziehen (Stand 0)." };
  const updated = await prisma.user.update({
    where: { id: userId }, data: { verdienteOrgasmen: { decrement: 1 } }, select: { verdienteOrgasmen: true },
  });
  await logBelohnungEvent(userId, "ENTZOGEN", -1, updated.verdienteOrgasmen, "Strafe: Guthaben entzogen");
  await notifyUser(userId, {
    subject: "Orgasmus-Entzug",
    message: `Dir wurde als Strafe 1 Belohnung entzogen. Verfügbares Guthaben: ${updated.verdienteOrgasmen}.`,
  });
  return { ok: true, data: { available: updated.verdienteOrgasmen } };
}

/** Verzug (Strafe): aktives Belohnungs-Fenster um `hours` Stunden nach hinten schieben. */
export async function delayReward(userId: string, hours: number): Promise<ServiceResult<{ endetAt: Date }>> {
  if (!Number.isFinite(hours) || hours <= 0) return { ok: false, status: 400, error: "Stunden (> 0) erforderlich" };
  const now = new Date();
  const win = await activeRewardWindow(userId, now);
  if (!win) return { ok: false, status: 400, error: "Kein aktives Belohnungs-Fenster zum Verschieben." };
  const neu = new Date(win.endetAt.getTime() + hours * 60 * 60 * 1000);
  await prisma.orgasmusAnforderung.update({ where: { id: win.id }, data: { endetAt: neu } });
  await logBelohnungEvent(userId, "VERSCHOBEN", 0, await currentBalance(userId), `Strafe: Fenster um ${hours} h verschoben`);
  await notifyUser(userId, {
    subject: "Belohnung verschoben",
    message: `Deine Belohnungs-Gelegenheit wurde als Strafe um ${hours} h verschoben.`,
  });
  return { ok: true, data: { endetAt: neu } };
}
