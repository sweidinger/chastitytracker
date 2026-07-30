import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { serviceFail, type ServiceResult } from "@/lib/serviceResult";
import {
  ZUFALL_OUTCOME_TYPES, ZUFALL_TRIGGER_TYPES, ZUFALL_WEIGHT_RANGE,
  type ZufallOutcomeType,
} from "@/lib/constants";
import { executePenaltyAction, type PenaltyActionType } from "@/lib/penaltyActions";
import { createOrgasmusAnforderung } from "@/lib/orgasmusAnforderungService";
import { updateSperrzeitEnde } from "@/lib/verschlussAnforderungService";
import { getActiveSperrzeit } from "@/lib/queries";
import { notifyUser } from "@/lib/notify";

/**
 * Zufalls-Engine (v4.129.0): gewichtete Zufallsziehungen, die eine Konsequenz auslösen.
 *
 * Ein Pool bündelt gewichtete Optionen; eine Ziehung wählt EINE Option (gewichtet, Gewichte vor dem
 * Sub verborgen) und wendet ihr Ergebnis über die BESTEHENDEN Konsequenz-Services an — nie über
 * eigene DB-Writes für die Konsequenz selbst (nur PENALTY ohne Straf-Aktion und TASK legen direkt an,
 * weil es dafür keinen Service gibt). Jede Ziehung wird als eingefrorenes Protokoll festgehalten.
 *
 * outcomeJson-Formen je outcomeType:
 *   TIME_ADD          { minutes }
 *   TIME_SUB          { minutes }
 *   PENALTY           { severity?, penaltyLabel?, action?: PenaltyActionType, hours?, windowHours?, text? }
 *   REWARD            { windowHours? }
 *   ORGASM_DIRECTIVE  { windowHours, vorgegebeneArt?, ruined? }
 *   SESSION_REQUEST   { categoryId, minMinuten?, delayMinutes?, deviceId?, requireVideo?, orgasmusZiel?, orgasmusRuiniert?, deadlineHours?, nachricht?, istStrafe? }
 *   NOTHING           {}
 */

const HARD_OUTCOMES: ReadonlySet<string> = new Set(["TIME_ADD", "PENALTY", "ORGASM_DIRECTIVE"]);
const DEFAULT_WINDOW_H = 24;
/** Mindest-Restlaufzeit (Minuten), auf die TIME_SUB eine Sperrzeit höchstens verkürzt (nie in die
 *  Vergangenheit — checkLockEnd würde sie sonst ablehnen). */
const MIN_LOCK_BUFFER_MIN = 5;
const MS_PER_HOUR = 60 * 60 * 1000;

export type ZufallDrawnBy = "sub" | "keyholder" | "ai" | "system";

/** Parsed typspezifische Parameter einer Option (tolerant; ungültig = {}). */
interface OutcomeParams {
  hours?: number;
  minutes?: number;
  windowHours?: number;
  action?: PenaltyActionType;
  text?: string;
  severity?: string;
  penaltyLabel?: string;
  vorgegebeneArt?: string | null;
  ruined?: boolean;
  // SESSION_REQUEST
  categoryId?: string;
  minMinuten?: number;
  delayMinutes?: number;
  deviceId?: string;
  requireVideo?: boolean;
  orgasmusZiel?: string;
  orgasmusRuiniert?: boolean;
  deadlineHours?: number;
  nachricht?: string;
  istStrafe?: boolean;
}

function parseOutcomeJson(raw: string | null | undefined): OutcomeParams {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as OutcomeParams) : {};
  } catch {
    return {};
  }
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : NaN);

/** Gewichtete Auswahl über kumulative Gewichte. `rng` liefert [0,1) — injizierbar für Determinismus. */
export function weightedPick<T extends { weight: number }>(items: T[], rng: () => number): T {
  const total = items.reduce((s, i) => s + Math.max(1, i.weight), 0);
  let r = rng() * total;
  for (const it of items) {
    r -= Math.max(1, it.weight);
    if (r < 0) return it;
  }
  return items[items.length - 1];
}

type ChosenOption = { id: string; label: string; weight: number; outcomeType: string; outcomeJson: string | null };

interface AppliedOutcome {
  appliedRefType: string | null;
  appliedRefId: string | null;
  outcomeType: ZufallOutcomeType;
  message: string;
}

/** Wendet das Ergebnis EINER gezogenen Option an und meldet, welche Konsequenz erzeugt wurde. Fällt
 *  eine Konsequenz mangels Voraussetzung aus (z.B. TIME_SUB ohne aktive Sperrzeit), wird sie zu
 *  NOTHING — es darf nie eine Konsequenz behauptet werden, die nicht eingetreten ist. */
async function applyOutcome(
  userId: string,
  opt: ChosenOption,
  pool: { maxAddH: number | null },
  now: Date,
): Promise<AppliedOutcome> {
  const p = parseOutcomeJson(opt.outcomeJson);
  const nothing = (message: string): AppliedOutcome => ({ appliedRefType: null, appliedRefId: null, outcomeType: "NOTHING", message });

  switch (opt.outcomeType as ZufallOutcomeType) {
    case "TIME_ADD": {
      let minutes = num(p.minutes);
      if (pool.maxAddH != null && pool.maxAddH > 0) minutes = Math.min(minutes, pool.maxAddH);
      if (!Number.isFinite(minutes) || minutes <= 0) return nothing("Keine gültige Verlängerung.");
      const res = await executePenaltyAction(userId, { type: "extend_lock", hours: minutes / 60 });
      return { appliedRefType: "SPERRZEIT", appliedRefId: null, outcomeType: "TIME_ADD", message: res.ok ? res.data.message : `Verlängerung fehlgeschlagen (${res.error}).` };
    }
    case "TIME_SUB": {
      const minutes = num(p.minutes);
      if (!Number.isFinite(minutes) || minutes <= 0) return nothing("Keine gültige Verkürzung.");
      const sperr = await getActiveSperrzeit(userId);
      if (!sperr || !sperr.endetAt) return nothing("Keine befristete Sperrzeit aktiv — nichts zu verkürzen.");
      const floor = new Date(now.getTime() + MIN_LOCK_BUFFER_MIN * 60 * 1000);
      const target = new Date(sperr.endetAt.getTime() - minutes * 60 * 1000);
      const clamped = target < floor ? floor : target;
      const res = await updateSperrzeitEnde(sperr.id, clamped);
      return { appliedRefType: "SPERRZEIT", appliedRefId: sperr.id, outcomeType: "TIME_SUB", message: res.ok ? `Sperrzeit um ${minutes} Min verkürzt.` : `Verkürzung fehlgeschlagen (${res.error}).` };
    }
    case "PENALTY": {
      // Der gewählte Strafbuch-Vorschlag (penaltyLabel) ist der Strafgrund; eine ggf. hinterlegte
      // Aktion wird zusätzlich ausgeführt. IMMER ein Strafbuch-Eintrag, gekennzeichnet als
      // "per Schicksalsrad" (judgedBy).
      const strafText = p.penaltyLabel?.trim() || p.text?.trim() || opt.label;
      let actionMsg = "";
      if (p.action) {
        const res = await executePenaltyAction(userId, { type: p.action, hours: p.hours, windowHours: p.windowHours });
        actionMsg = res.ok ? ` ${res.data.message}` : ` (Aktion fehlgeschlagen: ${res.error})`;
      }
      const rec = await prisma.strafeRecord.create({
        data: {
          userId,
          offenseType: "AI_KEYHOLDER",
          refId: `zufall:${randomUUID()}`,
          bestraftDatum: now,
          status: "PUNISHED",
          reason: strafText,
          notiz: p.severity ? `Schwere: ${p.severity}` : null,
          judgedBy: "schicksalsrad",
          erledigtAt: null,
        },
      });
      return { appliedRefType: "STRAFE", appliedRefId: rec.id, outcomeType: "PENALTY", message: `Strafe verhängt: ${strafText}.${actionMsg}` };
    }
    case "REWARD": {
      // Belohnungs-Fenster OHNE das verdiente-Guthaben-Gate (bewusst NICHT grantBelohnung, das
      // available>=1 verlangt): eine Zufalls-Belohnung ist ein Glücksfall, kein eingelöstes Guthaben.
      const windowH = num(p.windowHours) > 0 ? num(p.windowHours) : DEFAULT_WINDOW_H;
      const res = await createOrgasmusAnforderung({
        userId, art: "GELEGENHEIT", istBelohnung: true, vorgegebeneArt: "Belohnung", oeffnenErlaubt: true,
        beginntAt: now, endetAt: new Date(now.getTime() + windowH * MS_PER_HOUR),
        nachricht: "Zufall: Belohnungs-Fenster",
      });
      if (!res.ok) return nothing(`Belohnung nicht anwendbar (${res.error}).`);
      return { appliedRefType: "ORGASMUS_ANFORDERUNG", appliedRefId: res.data.id, outcomeType: "REWARD", message: `Belohnungs-Fenster über ${windowH} h gewährt.` };
    }
    case "ORGASM_DIRECTIVE": {
      const windowH = num(p.windowHours) > 0 ? num(p.windowHours) : DEFAULT_WINDOW_H;
      const ruined = !!p.ruined;
      const res = await createOrgasmusAnforderung({
        userId, art: "ANWEISUNG", istStrafe: ruined,
        vorgegebeneArt: ruined ? "ruinierter Orgasmus" : (p.vorgegebeneArt ?? null),
        oeffnenErlaubt: false,
        beginntAt: now, endetAt: new Date(now.getTime() + windowH * MS_PER_HOUR),
        nachricht: "Zufall: Orgasmus-Anweisung",
      });
      if (!res.ok) return nothing(`Orgasmus-Anweisung nicht anwendbar (${res.error}).`);
      return { appliedRefType: "ORGASMUS_ANFORDERUNG", appliedRefId: res.data.id, outcomeType: "ORGASM_DIRECTIVE", message: `Orgasmus-Anweisung angeordnet (Fenster ${windowH} h).` };
    }
    case "SESSION_REQUEST": {
      const catId = typeof p.categoryId === "string" ? p.categoryId : "";
      const cat = catId
        ? await prisma.deviceCategory.findFirst({ where: { id: catId, userId, isSessionCategory: true }, select: { id: true, name: true, maxSessionMinutes: true, requiresVideo: true, orgasmusZiel: true } })
        : null;
      if (!cat) return nothing("Session-Anforderung nicht anwendbar (Kategorie fehlt).");
      let sessDeviceId: string | null = null;
      if (typeof p.deviceId === "string" && p.deviceId) {
        const dev = await prisma.device.findFirst({ where: { id: p.deviceId, userId, categoryId: cat.id, archivedAt: null }, select: { id: true } });
        sessDeviceId = dev?.id ?? null;
      }
      const delayMin = num(p.delayMinutes) > 0 ? num(p.delayMinutes) : 0;
      const wirksamAb = delayMin > 0 ? new Date(now.getTime() + delayMin * 60 * 1000) : null;
      const startBase = wirksamAb ? wirksamAb.getTime() : now.getTime();
      const deadlineH = num(p.deadlineHours);
      const endetAt = deadlineH > 0 ? new Date(startBase + deadlineH * MS_PER_HOUR) : null;
      const minMin = num(p.minMinuten) > 0 ? Math.min(Math.round(num(p.minMinuten)), cat.maxSessionMinutes) : null;
      const ziel = typeof p.orgasmusZiel === "string" && ["KEINE", "ERFORDERLICH", "VERBOTEN"].includes(p.orgasmusZiel) ? p.orgasmusZiel : cat.orgasmusZiel;
      const ruiniert = ziel === "ERFORDERLICH" && !!p.orgasmusRuiniert;
      const anf = await prisma.sessionAnforderung.create({
        data: {
          userId, deviceCategoryId: cat.id,
          nachricht: (typeof p.nachricht === "string" && p.nachricht.trim()) ? p.nachricht.trim() : "Zufall: Session-Anforderung",
          endetAt, minMinuten: minMin, requireVideo: !!p.requireVideo || cat.requiresVideo,
          orgasmusZiel: ziel, orgasmusRuiniert: ruiniert, wirksamAb, deviceId: sessDeviceId, istStrafe: !!p.istStrafe,
        },
      });
      return { appliedRefType: "SESSION_ANFORDERUNG", appliedRefId: anf.id, outcomeType: "SESSION_REQUEST", message: `Session angefordert: ${cat.name}${minMin ? `, min. ${minMin} Min` : ""}${endetAt ? `, Frist ${deadlineH} h` : ""}.` };
    }
    case "NOTHING":
    default:
      return nothing("Nichts passiert.");
  }
}

/**
 * Zieht eine Option aus einem aktiven Pool, wendet ihr Ergebnis an und protokolliert die Ziehung.
 * Der einzige Schreibpfad der Engine — geteilt von der Sub- und der Keyholder-/Admin-Route.
 */
export async function drawFromPool(
  poolId: string,
  drawnBy: ZufallDrawnBy,
  opts?: { rng?: () => number; now?: Date },
): Promise<ServiceResult<{ ziehungId: string; optionLabel: string; outcomeType: ZufallOutcomeType; message: string }>> {
  const now = opts?.now ?? new Date();
  const rng = opts?.rng ?? Math.random;

  const pool = await prisma.zufallsPool.findUnique({
    where: { id: poolId },
    include: { options: { orderBy: { sort: "asc" } } },
  });
  if (!pool || !pool.aktiv) return serviceFail(404, "ZUFALL_POOL_NOT_FOUND");
  const userId = pool.userId;
  const options = pool.options as ChosenOption[];
  if (options.length === 0) return serviceFail(400, "ZUFALL_NO_OPTIONS");

  // Cooldown: Abstand zur letzten Ziehung DIESES Pools.
  if (pool.cooldownMin && pool.cooldownMin > 0) {
    const last = await prisma.zufallsZiehung.findFirst({ where: { poolId }, orderBy: { drawnAt: "desc" }, select: { drawnAt: true } });
    if (last && now.getTime() - last.drawnAt.getTime() < pool.cooldownMin * 60 * 1000) {
      return serviceFail(429, "ZUFALL_COOLDOWN_ACTIVE");
    }
  }

  // Gesundheits-Zurückhaltung (§8): bei aktivem HealthHold harte Konsequenzen aus dem Kandidatenkreis
  // nehmen. Bleibt dann nichts übrig, wird die Ziehung erzwungen zu NOTHING (Rad landet trotzdem auf
  // einem Label, aber ohne harte Folge).
  const hold = await prisma.healthHold.findFirst({ where: { userId, active: true }, select: { id: true } });
  let candidates = options;
  let forcedNothing = false;
  if (hold) {
    const soft = options.filter((o) => !HARD_OUTCOMES.has(o.outcomeType));
    if (soft.length === 0) forcedNothing = true;
    else candidates = soft;
  }

  const chosen = weightedPick(forcedNothing ? options : candidates, rng);
  const applied: AppliedOutcome = forcedNothing
    ? { appliedRefType: null, appliedRefId: null, outcomeType: "NOTHING", message: "Nichts passiert (Gesundheits-Zurückhaltung aktiv)." }
    : await applyOutcome(userId, chosen, pool, now);

  const ziehung = await prisma.zufallsZiehung.create({
    data: {
      userId,
      poolId,
      optionId: chosen.id,
      optionLabel: chosen.label,          // eingefroren
      outcomeType: applied.outcomeType,   // effektiv (ggf. NOTHING statt geplanter Konsequenz)
      drawnBy,
      drawnAt: now,
      appliedRefType: applied.appliedRefType,
      appliedRefId: applied.appliedRefId,
      detail: applied.message,
    },
  });

  await notifyUser(userId, {
    subjectKey: "zufallResultSubject",
    messageKey: "zufallResultMessage",
    params: { label: chosen.label },
    url: "/dashboard/zufall",
  });

  return { ok: true, data: { ziehungId: ziehung.id, optionLabel: chosen.label, outcomeType: applied.outcomeType, message: applied.message } };
}

// ── Pool-/Options-CRUD ────────────────────────────────────────────────────────

export interface ZufallsOptionInput {
  label: string;
  weight?: number;
  outcomeType: string;
  outcomeJson?: string | null;
  sort?: number;
}

export interface CreateZufallsPoolInput {
  userId: string;
  name: string;
  aktiv?: boolean;
  triggerType?: string;
  cooldownMin?: number | null;
  maxAddH?: number | null;
  createdBy: string; // "admin" | "keyholder"
  options?: ZufallsOptionInput[];
}

export interface UpdateZufallsPoolPatch {
  name?: string;
  aktiv?: boolean;
  cooldownMin?: number | null;
  maxAddH?: number | null;
}

/** Validiert eine Options-Liste (Typ ∈ Set, Gewicht im Bereich, Label nicht leer, outcomeJson je Typ
 *  parsebar/plausibel). Gibt einen Fehler-Code zurück oder null. */
export function validateOptions(options: ZufallsOptionInput[]): "ZUFALL_INVALID_OUTCOME" | "ZUFALL_INVALID_INPUT" | null {
  for (const o of options) {
    if (!o.label || !o.label.trim()) return "ZUFALL_INVALID_INPUT";
    if (!(ZUFALL_OUTCOME_TYPES as readonly string[]).includes(o.outcomeType)) return "ZUFALL_INVALID_OUTCOME";
    const w = o.weight ?? ZUFALL_WEIGHT_RANGE.fallback;
    if (!Number.isFinite(w) || w < ZUFALL_WEIGHT_RANGE.min || w > ZUFALL_WEIGHT_RANGE.max) return "ZUFALL_INVALID_INPUT";
    if (o.outcomeJson) {
      let parsed: unknown;
      try { parsed = JSON.parse(o.outcomeJson); } catch { return "ZUFALL_INVALID_INPUT"; }
      if (parsed === null || typeof parsed !== "object") return "ZUFALL_INVALID_INPUT";
      const p = parsed as OutcomeParams;
      // Typspezifische Pflichtfelder.
      if ((o.outcomeType === "TIME_ADD" || o.outcomeType === "TIME_SUB") && !(num(p.minutes) > 0)) return "ZUFALL_INVALID_OUTCOME";
      if (o.outcomeType === "SESSION_REQUEST" && !(p.categoryId && String(p.categoryId).trim())) return "ZUFALL_INVALID_OUTCOME";
      if (o.outcomeType === "ORGASM_DIRECTIVE" && !(num(p.windowHours) > 0)) return "ZUFALL_INVALID_OUTCOME";
    } else if (o.outcomeType === "TIME_ADD" || o.outcomeType === "TIME_SUB" || o.outcomeType === "SESSION_REQUEST" || o.outcomeType === "ORGASM_DIRECTIVE" || o.outcomeType === "PENALTY") {
      // Diese Typen brauchen zwingend Parameter.
      return "ZUFALL_INVALID_OUTCOME";
    }
  }
  return null;
}

/** Resolves the owning userId of a pool (for the auth guard), or null if missing. */
export async function getPoolOwner(poolId: string): Promise<string | null> {
  const pool = await prisma.zufallsPool.findUnique({ where: { id: poolId }, select: { userId: true } });
  return pool?.userId ?? null;
}

export async function createZufallsPool(input: CreateZufallsPoolInput): Promise<ServiceResult<{ id: string }>> {
  if (!input.userId) return serviceFail(400, "USER_ID_REQUIRED");
  if (!input.name || !input.name.trim()) return serviceFail(400, "ZUFALL_INVALID_INPUT");
  const triggerType = input.triggerType ?? "MANUAL";
  if (!(ZUFALL_TRIGGER_TYPES as readonly string[]).includes(triggerType)) return serviceFail(400, "ZUFALL_INVALID_INPUT");
  if (input.options && input.options.length > 0) {
    const err = validateOptions(input.options);
    if (err) return serviceFail(400, err);
  }
  const pool = await prisma.zufallsPool.create({
    data: {
      userId: input.userId,
      name: input.name.trim(),
      aktiv: input.aktiv ?? true,
      triggerType,
      cooldownMin: input.cooldownMin ?? null,
      maxAddH: input.maxAddH ?? null,
      createdBy: input.createdBy,
      ...(input.options && input.options.length > 0
        ? { options: { create: input.options.map((o, i) => ({ label: o.label.trim(), weight: o.weight ?? ZUFALL_WEIGHT_RANGE.fallback, outcomeType: o.outcomeType, outcomeJson: o.outcomeJson?.trim() || null, sort: o.sort ?? i })) } }
        : {}),
    },
  });
  return { ok: true, data: { id: pool.id } };
}

export async function updateZufallsPool(id: string, patch: UpdateZufallsPoolPatch): Promise<ServiceResult<{ id: string; userId: string }>> {
  const pool = await prisma.zufallsPool.findUnique({ where: { id }, select: { userId: true } });
  if (!pool) return serviceFail(404, "ZUFALL_POOL_NOT_FOUND");
  if (patch.name !== undefined && !patch.name.trim()) return serviceFail(400, "ZUFALL_INVALID_INPUT");
  await prisma.zufallsPool.update({
    where: { id },
    data: {
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.aktiv !== undefined ? { aktiv: patch.aktiv } : {}),
      ...(patch.cooldownMin !== undefined ? { cooldownMin: patch.cooldownMin } : {}),
      ...(patch.maxAddH !== undefined ? { maxAddH: patch.maxAddH } : {}),
    },
  });
  return { ok: true, data: { id, userId: pool.userId } };
}

export async function deleteZufallsPool(id: string): Promise<ServiceResult<{ userId: string }>> {
  const pool = await prisma.zufallsPool.findUnique({ where: { id }, select: { userId: true } });
  if (!pool) return serviceFail(404, "ZUFALL_POOL_NOT_FOUND");
  await prisma.zufallsPool.delete({ where: { id } });
  return { ok: true, data: { userId: pool.userId } };
}

/** Ersetzt die Optionen eines Pools vollständig (overwrite-Semantik wie das Admin-Formular). */
export async function setPoolOptions(poolId: string, options: ZufallsOptionInput[]): Promise<ServiceResult<{ count: number }>> {
  const pool = await prisma.zufallsPool.findUnique({ where: { id: poolId }, select: { id: true } });
  if (!pool) return serviceFail(404, "ZUFALL_POOL_NOT_FOUND");
  const err = validateOptions(options);
  if (err) return serviceFail(400, err);
  await prisma.$transaction([
    prisma.zufallsOption.deleteMany({ where: { poolId } }),
    prisma.zufallsOption.createMany({
      data: options.map((o, i) => ({ poolId, label: o.label.trim(), weight: o.weight ?? ZUFALL_WEIGHT_RANGE.fallback, outcomeType: o.outcomeType, outcomeJson: o.outcomeJson?.trim() || null, sort: o.sort ?? i })),
    }),
  ]);
  return { ok: true, data: { count: options.length } };
}

/** Alle Pools eines Users mit ihren Optionen (Keyholder-/Admin-Editor). */
export async function listZufallsPools(userId: string) {
  return prisma.zufallsPool.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { options: { orderBy: { sort: "asc" } } },
  });
}

/** Aktive, manuell auslösbare Pools (id + name + Cooldown-Status) — für die Sub-Sicht, OHNE
 *  Gewichte/Optionen. `nextDrawAt` (ISO) = frühester nächster Zug wegen Cooldown; null = jetzt erlaubt. */
export async function listActiveManualPools(userId: string): Promise<{ id: string; name: string; cooldownMin: number; nextDrawAt: string | null }[]> {
  const pools = await prisma.zufallsPool.findMany({
    where: { userId, aktiv: true, triggerType: "MANUAL" },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, cooldownMin: true },
  });
  if (pools.length === 0) return [];
  const cooldownPoolIds = pools.filter((p) => p.cooldownMin && p.cooldownMin > 0).map((p) => p.id);
  const lastByPool = new Map<string, Date>();
  if (cooldownPoolIds.length > 0) {
    const grouped = await prisma.zufallsZiehung.groupBy({
      by: ["poolId"],
      where: { poolId: { in: cooldownPoolIds } },
      _max: { drawnAt: true },
    });
    for (const g of grouped) if (g._max.drawnAt) lastByPool.set(g.poolId, g._max.drawnAt);
  }
  const nowMs = Date.now();
  return pools.map((p) => {
    const cd = p.cooldownMin ?? 0;
    let nextDrawAt: string | null = null;
    if (cd > 0) {
      const last = lastByPool.get(p.id);
      if (last) {
        const next = last.getTime() + cd * 60 * 1000;
        if (next > nowMs) nextDrawAt = new Date(next).toISOString();
      }
    }
    return { id: p.id, name: p.name, cooldownMin: cd, nextDrawAt };
  });
}

export interface ZiehungListItem { id: string; optionLabel: string; outcomeType: string; drawnAt: string; detail: string | null; }

/** Letzte Ziehungen eines Subs (neueste zuerst) — für die Historie-Ansicht. */
export async function listZiehungen(userId: string, limit = 10): Promise<ZiehungListItem[]> {
  const rows = await prisma.zufallsZiehung.findMany({
    where: { userId },
    orderBy: { drawnAt: "desc" },
    take: limit,
    select: { id: true, optionLabel: true, outcomeType: true, drawnAt: true, detail: true },
  });
  return rows.map((r) => ({ id: r.id, optionLabel: r.optionLabel, outcomeType: r.outcomeType, drawnAt: r.drawnAt.toISOString(), detail: r.detail }));
}
