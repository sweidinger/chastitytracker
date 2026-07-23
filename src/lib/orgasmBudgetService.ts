import { prisma } from "@/lib/prisma";
import { getWeekStart, getMonthStart, APP_TZ } from "@/lib/utils";
import { parseOrgasmusArtBase } from "@/lib/constants";

export type OrgasmBudgetPeriode = "WOCHE" | "MONAT";

export interface OrgasmBudgetState {
  /** null = kein Budget aktiv (Feature aus fuer diesen User). */
  limit: number | null;
  /** Zaehlbare Orgasmen im laufenden Zeitraum. */
  used: number;
  /** Math.max(0, limit-used) oder null wenn kein Budget. */
  remaining: number | null;
  periode: OrgasmBudgetPeriode;
  periodStart: Date;
}

/** Unfreiwillige "feuchte Traeume" zaehlen NICHT gegen das Budget. */
const NICHT_ZAEHLBAR_ART = "feuchter Traum";

export function normPeriode(v: string | null | undefined): OrgasmBudgetPeriode {
  return v === "MONAT" ? "MONAT" : "WOCHE";
}

export function orgasmBudgetPeriodStart(periode: OrgasmBudgetPeriode, now: Date, tz: string): Date {
  return periode === "MONAT" ? getMonthStart(now, tz) : getWeekStart(now, tz);
}

/** Live-Zustand des Orgasmus-Budgets: zaehlt echte, nicht von einer erfuellten Anforderung/Belohnung
 *  gedeckte Orgasmen (ohne "feuchter Traum") im laufenden Zeitraum. */
export async function getOrgasmusBudgetState(userId: string, now: Date, tz: string = APP_TZ): Promise<OrgasmBudgetState> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { orgasmBudget: true, orgasmBudgetPeriode: true },
  });
  const periode = normPeriode(user?.orgasmBudgetPeriode);
  const limit = user?.orgasmBudget ?? null;
  const periodStart = orgasmBudgetPeriodStart(periode, now, tz);

  const orgasms = await prisma.entry.findMany({
    where: { userId, type: "ORGASMUS", startTime: { gte: periodStart } },
    select: { id: true, orgasmusArt: true, orgasmusAnforderung: { select: { fulfilledAt: true } } },
  });
  const used = orgasms.filter((o) => {
    if (parseOrgasmusArtBase(o.orgasmusArt) === NICHT_ZAEHLBAR_ART) return false; // unfreiwillig
    if (o.orgasmusAnforderung?.fulfilledAt) return false;                          // von Anforderung/Belohnung gedeckt
    return true;
  }).length;

  const remaining = limit != null ? Math.max(0, limit - used) : null;
  return { limit, used, remaining, periode, periodStart };
}

export type SetOrgasmBudgetResult = { ok: true } | { ok: false; error: string };

/** Admin/Keyholder-Setzen des Budgets. budget=null schaltet das Budget ab.
 *  Plain { ok, error }-Konvention (wie createVorgabe) — nutzbar von der Admin-Route UND der KI-Aktion. */
export async function setOrgasmBudgetSettings(
  userId: string,
  opts: { budget?: number | null; periode?: string },
): Promise<SetOrgasmBudgetResult> {
  const data: { orgasmBudget?: number | null; orgasmBudgetPeriode?: string; orgasmBudgetSetAt?: Date } = {};
  if (opts.budget !== undefined) {
    data.orgasmBudget = opts.budget === null ? null : Math.max(0, Math.min(99, Math.floor(Number(opts.budget) || 0)));
  }
  if (opts.periode !== undefined) {
    if (opts.periode !== "WOCHE" && opts.periode !== "MONAT") return { ok: false, error: "invalidPeriode" };
    data.orgasmBudgetPeriode = opts.periode;
  }
  if (Object.keys(data).length === 0) return { ok: false, error: "noChange" };
  // Stichtag setzen, wenn das Budget-Regelwerk sich aendert: so werden Orgasmen VOR diesem Moment
  // nicht rueckwirkend als Verstoss gewertet (siehe getOrgasmOverBudgetViolations).
  if ((opts.budget !== undefined && opts.budget !== null) || opts.periode !== undefined) {
    data.orgasmBudgetSetAt = new Date();
  }
  await prisma.user.update({ where: { id: userId }, data });
  return { ok: true };
}

export interface OrgasmOverBudgetViolation {
  entryId: string;
  startTime: Date;
  orgasmusArt: string | null;
  used: number;
  limit: number;
}

/** Orgasmen im laufenden Zeitraum ueber dem Budget (Index >= limit) UND nach dem Setzen des Budgets
 *  (orgasmBudgetSetAt) — so wird ein mitten im Zeitraum gesetztes/gesenktes Budget NICHT rueckwirkend
 *  auf frueher liegende Orgasmen angewandt. Reine Erkennung (kein Auto-Urteil). */
export async function getOrgasmOverBudgetViolations(userId: string, now: Date, tz: string = APP_TZ): Promise<OrgasmOverBudgetViolation[]> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { orgasmBudget: true, orgasmBudgetPeriode: true, orgasmBudgetSetAt: true },
  });
  const limit = user?.orgasmBudget ?? null;
  if (limit == null) return [];
  const periode = normPeriode(user?.orgasmBudgetPeriode);
  const periodStart = orgasmBudgetPeriodStart(periode, now, tz);
  const setAt = user?.orgasmBudgetSetAt ?? null;
  const cutoff = setAt && setAt > periodStart ? setAt : periodStart;

  const orgasms = await prisma.entry.findMany({
    where: { userId, type: "ORGASMUS", startTime: { gte: periodStart } },
    orderBy: { startTime: "asc" },
    select: { id: true, startTime: true, orgasmusArt: true, orgasmusAnforderung: { select: { fulfilledAt: true } } },
  });
  const countable = orgasms.filter(
    (o) => parseOrgasmusArtBase(o.orgasmusArt) !== NICHT_ZAEHLBAR_ART && !o.orgasmusAnforderung?.fulfilledAt,
  );
  const used = countable.length;
  const violations: OrgasmOverBudgetViolation[] = [];
  countable.forEach((o, idx) => {
    if (idx >= limit && o.startTime >= cutoff) {
      violations.push({ entryId: o.id, startTime: o.startTime, orgasmusArt: o.orgasmusArt, used, limit });
    }
  });
  violations.reverse();
  return violations;
}
