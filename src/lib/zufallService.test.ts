import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────
// vi.hoisted: der Mock-Factory (nach oben gehoistet) darf `db` sonst noch nicht sehen.
const db = vi.hoisted(() => ({
  zufallsPool: { findUnique: vi.fn() },
  zufallsZiehung: { findFirst: vi.fn(), create: vi.fn() },
  healthHold: { findFirst: vi.fn() },
  strafeRecord: { create: vi.fn() },
  keyholderTask: { create: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/penaltyActions", () => ({ executePenaltyAction: vi.fn() }));
vi.mock("@/lib/orgasmusAnforderungService", () => ({ createOrgasmusAnforderung: vi.fn() }));
vi.mock("@/lib/verschlussAnforderungService", () => ({ updateSperrzeitEnde: vi.fn() }));
vi.mock("@/lib/queries", () => ({ getActiveSperrzeit: vi.fn() }));
vi.mock("@/lib/notify", () => ({ notifyUser: vi.fn() }));

import { drawFromPool, weightedPick } from "./zufallService";
import { executePenaltyAction } from "@/lib/penaltyActions";
import { createOrgasmusAnforderung } from "@/lib/orgasmusAnforderungService";
import { updateSperrzeitEnde } from "@/lib/verschlussAnforderungService";
import { getActiveSperrzeit } from "@/lib/queries";
import { notifyUser } from "@/lib/notify";

const mExec = executePenaltyAction as unknown as ReturnType<typeof vi.fn>;
const mOrgasm = createOrgasmusAnforderung as unknown as ReturnType<typeof vi.fn>;
const mUpdateSperr = updateSperrzeitEnde as unknown as ReturnType<typeof vi.fn>;
const mGetSperr = getActiveSperrzeit as unknown as ReturnType<typeof vi.fn>;
const mNotify = notifyUser as unknown as ReturnType<typeof vi.fn>;

const NOW = new Date("2026-07-29T12:00:00Z");

type Opt = { id: string; label: string; weight: number; outcomeType: string; outcomeJson: string | null };
function opt(o: Partial<Opt> & { outcomeType: string }): Opt {
  return { id: o.id ?? "o", label: o.label ?? "L", weight: o.weight ?? 1, outcomeJson: o.outcomeJson ?? null, outcomeType: o.outcomeType };
}
function mockPool(options: Opt[], extra: Partial<{ aktiv: boolean; cooldownMin: number | null; maxAddH: number | null }> = {}) {
  db.zufallsPool.findUnique.mockResolvedValue({
    id: "p1", userId: "u1", aktiv: extra.aktiv ?? true, triggerType: "MANUAL",
    cooldownMin: extra.cooldownMin ?? null, maxAddH: extra.maxAddH ?? null, options,
  });
}
/** rng that lands on the first candidate (r stays < first cumulative weight). */
const rngFirst = () => 0;

beforeEach(() => {
  vi.clearAllMocks();
  db.zufallsZiehung.findFirst.mockResolvedValue(null);
  db.zufallsZiehung.create.mockResolvedValue({ id: "z1" });
  db.healthHold.findFirst.mockResolvedValue(null);
  db.strafeRecord.create.mockResolvedValue({ id: "str1", reason: "R" });
  db.keyholderTask.create.mockResolvedValue({ id: "task1" });
  mExec.mockResolvedValue({ ok: true, data: { message: "done" } });
  mOrgasm.mockResolvedValue({ ok: true, data: { id: "org1" } });
  mUpdateSperr.mockResolvedValue({ ok: true, data: { id: "s1", userId: "u1", notified: true } });
  mGetSperr.mockResolvedValue(null);
});
afterEach(() => vi.restoreAllMocks());

// ── weightedPick ────────────────────────────────────────────────────────────
describe("weightedPick — deterministisch mit injiziertem rng", () => {
  const items = [{ id: "a", weight: 1 }, { id: "b", weight: 9 }];
  it("kleiner rng-Wert → erstes Item (schmales Segment)", () => {
    expect(weightedPick(items, () => 0.05).id).toBe("a"); // 0.5 < 1
  });
  it("grosser rng-Wert → schweres Item", () => {
    expect(weightedPick(items, () => 0.5).id).toBe("b"); // 5 → über Segment a
  });
  it("respektiert Gewichte: Grenze bei w_a/total", () => {
    // total 10, Segment a = [0,1) → rng 0.099*10=0.99 < 1 → a; 0.11*10=1.1 → b
    expect(weightedPick(items, () => 0.099).id).toBe("a");
    expect(weightedPick(items, () => 0.11).id).toBe("b");
  });
});

// ── drawFromPool: Grundfälle ──────────────────────────────────────────────────
describe("drawFromPool — Guards", () => {
  it("Pool nicht gefunden → ZUFALL_POOL_NOT_FOUND", async () => {
    db.zufallsPool.findUnique.mockResolvedValue(null);
    const r = await drawFromPool("p1", "sub", { now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("ZUFALL_POOL_NOT_FOUND");
  });
  it("inaktiver Pool → ZUFALL_POOL_NOT_FOUND", async () => {
    mockPool([opt({ outcomeType: "NOTHING" })], { aktiv: false });
    const r = await drawFromPool("p1", "sub", { now: NOW });
    if (r.ok) throw new Error("erwartet Fehler");
    expect(r.error).toBe("ZUFALL_POOL_NOT_FOUND");
  });
  it("keine Optionen → ZUFALL_NO_OPTIONS", async () => {
    mockPool([]);
    const r = await drawFromPool("p1", "sub", { now: NOW });
    if (r.ok) throw new Error("erwartet Fehler");
    expect(r.error).toBe("ZUFALL_NO_OPTIONS");
  });
  it("Cooldown aktiv → ZUFALL_COOLDOWN_ACTIVE", async () => {
    mockPool([opt({ outcomeType: "NOTHING" })], { cooldownMin: 60 });
    db.zufallsZiehung.findFirst.mockResolvedValue({ drawnAt: new Date(NOW.getTime() - 10 * 60 * 1000) });
    const r = await drawFromPool("p1", "sub", { now: NOW });
    if (r.ok) throw new Error("erwartet Fehler");
    expect(r.error).toBe("ZUFALL_COOLDOWN_ACTIVE");
    expect(db.zufallsZiehung.create).not.toHaveBeenCalled();
  });
  it("Cooldown abgelaufen → Ziehung erfolgt", async () => {
    mockPool([opt({ outcomeType: "NOTHING" })], { cooldownMin: 60 });
    db.zufallsZiehung.findFirst.mockResolvedValue({ drawnAt: new Date(NOW.getTime() - 120 * 60 * 1000) });
    const r = await drawFromPool("p1", "sub", { now: NOW });
    expect(r.ok).toBe(true);
    expect(db.zufallsZiehung.create).toHaveBeenCalledTimes(1);
    expect(mNotify).toHaveBeenCalledTimes(1);
  });
});

// ── Outcome-Dispatch ──────────────────────────────────────────────────────────
describe("drawFromPool — jeder outcomeType ruft die richtige Konsequenz", () => {
  it("TIME_ADD → executePenaltyAction extend_lock", async () => {
    mockPool([opt({ outcomeType: "TIME_ADD", outcomeJson: JSON.stringify({ hours: 5 }) })]);
    const r = await drawFromPool("p1", "sub", { now: NOW, rng: rngFirst });
    expect(r.ok).toBe(true);
    expect(mExec).toHaveBeenCalledWith("u1", { type: "extend_lock", hours: 5 });
    expect(db.zufallsZiehung.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ outcomeType: "TIME_ADD", appliedRefType: "SPERRZEIT" }) }));
  });

  it("TIME_ADD respektiert maxAddH-Deckelung", async () => {
    mockPool([opt({ outcomeType: "TIME_ADD", outcomeJson: JSON.stringify({ hours: 10 }) })], { maxAddH: 2 });
    await drawFromPool("p1", "sub", { now: NOW, rng: rngFirst });
    expect(mExec).toHaveBeenCalledWith("u1", { type: "extend_lock", hours: 2 });
  });

  it("TIME_SUB → updateSperrzeitEnde auf verkürztes Ende", async () => {
    mGetSperr.mockResolvedValue({ id: "s1", endetAt: new Date(NOW.getTime() + 10 * 60 * 60 * 1000) });
    mockPool([opt({ outcomeType: "TIME_SUB", outcomeJson: JSON.stringify({ hours: 3 }) })]);
    const r = await drawFromPool("p1", "sub", { now: NOW, rng: rngFirst });
    expect(r.ok).toBe(true);
    expect(mUpdateSperr).toHaveBeenCalledTimes(1);
    const [id, endetAt] = mUpdateSperr.mock.calls[0];
    expect(id).toBe("s1");
    expect((endetAt as Date).getTime()).toBe(NOW.getTime() + 7 * 60 * 60 * 1000);
  });

  it("TIME_SUB ohne aktive Sperrzeit → NOTHING, kein Update", async () => {
    mGetSperr.mockResolvedValue(null);
    mockPool([opt({ outcomeType: "TIME_SUB", outcomeJson: JSON.stringify({ hours: 3 }) })]);
    const r = await drawFromPool("p1", "sub", { now: NOW, rng: rngFirst });
    if (!r.ok) throw new Error("erwartet ok");
    expect(r.data.outcomeType).toBe("NOTHING");
    expect(mUpdateSperr).not.toHaveBeenCalled();
  });

  it("PENALTY mit action → executePenaltyAction mit diesem Typ", async () => {
    mockPool([opt({ outcomeType: "PENALTY", outcomeJson: JSON.stringify({ action: "ruined_orgasm", windowHours: 12 }) })]);
    await drawFromPool("p1", "sub", { now: NOW, rng: rngFirst });
    expect(mExec).toHaveBeenCalledWith("u1", { type: "ruined_orgasm", hours: undefined, windowHours: 12 });
  });

  it("PENALTY ohne action → freier StrafeRecord (offenseType AI_KEYHOLDER, refId zufall:...)", async () => {
    mockPool([opt({ label: "Klaps", outcomeType: "PENALTY", outcomeJson: JSON.stringify({ text: "20 Schläge" }) })]);
    await drawFromPool("p1", "sub", { now: NOW, rng: rngFirst });
    expect(db.strafeRecord.create).toHaveBeenCalledTimes(1);
    const arg = db.strafeRecord.create.mock.calls[0][0];
    expect(arg.data.offenseType).toBe("AI_KEYHOLDER");
    expect(arg.data.status).toBe("PUNISHED");
    expect(arg.data.judgedBy).toBe("system");
    expect(String(arg.data.refId)).toMatch(/^zufall:/);
    expect(mExec).not.toHaveBeenCalled();
  });

  it("REWARD → createOrgasmusAnforderung GELEGENHEIT/istBelohnung", async () => {
    mockPool([opt({ outcomeType: "REWARD", outcomeJson: JSON.stringify({ windowHours: 6 }) })]);
    await drawFromPool("p1", "sub", { now: NOW, rng: rngFirst });
    expect(mOrgasm).toHaveBeenCalledWith(expect.objectContaining({ art: "GELEGENHEIT", istBelohnung: true, vorgegebeneArt: "Belohnung" }));
  });

  it("ORGASM_DIRECTIVE ruined → ANWEISUNG istStrafe + ruinierter Orgasmus", async () => {
    mockPool([opt({ outcomeType: "ORGASM_DIRECTIVE", outcomeJson: JSON.stringify({ windowHours: 24, ruined: true }) })]);
    await drawFromPool("p1", "sub", { now: NOW, rng: rngFirst });
    expect(mOrgasm).toHaveBeenCalledWith(expect.objectContaining({ art: "ANWEISUNG", istStrafe: true, vorgegebeneArt: "ruinierter Orgasmus" }));
  });

  it("TASK → keyholderTask.create WRITE_RESPONSE", async () => {
    mockPool([opt({ outcomeType: "TASK", outcomeJson: JSON.stringify({ text: "Schreibe 200 Wörter", dueH: 24 }) })]);
    await drawFromPool("p1", "sub", { now: NOW, rng: rngFirst });
    expect(db.keyholderTask.create).toHaveBeenCalledTimes(1);
    const arg = db.keyholderTask.create.mock.calls[0][0];
    expect(arg.data.type).toBe("WRITE_RESPONSE");
    expect(arg.data.message).toBe("Schreibe 200 Wörter");
  });

  it("NOTHING → keine Konsequenz", async () => {
    mockPool([opt({ outcomeType: "NOTHING" })]);
    const r = await drawFromPool("p1", "sub", { now: NOW, rng: rngFirst });
    if (!r.ok) throw new Error("erwartet ok");
    expect(r.data.outcomeType).toBe("NOTHING");
    expect(mExec).not.toHaveBeenCalled();
    expect(mOrgasm).not.toHaveBeenCalled();
  });
});

// ── HealthHold ────────────────────────────────────────────────────────────────
describe("drawFromPool — HealthHold entfernt harte Konsequenzen", () => {
  it("harte Option wird bei aktivem Hold nie gewählt (nur die weiche bleibt)", async () => {
    db.healthHold.findFirst.mockResolvedValue({ id: "h1" });
    // rngFirst würde ohne Filter die harte TIME_ADD (erste) wählen; mit Filter bleibt nur NOTHING.
    mockPool([
      opt({ id: "hard", label: "Sperrzeit +5h", weight: 100, outcomeType: "TIME_ADD", outcomeJson: JSON.stringify({ hours: 5 }) }),
      opt({ id: "soft", label: "Nichts", weight: 1, outcomeType: "NOTHING" }),
    ]);
    const r = await drawFromPool("p1", "sub", { now: NOW, rng: rngFirst });
    if (!r.ok) throw new Error("erwartet ok");
    expect(r.data.optionLabel).toBe("Nichts");
    expect(r.data.outcomeType).toBe("NOTHING");
    expect(mExec).not.toHaveBeenCalled();
  });

  it("nur harte Optionen + Hold → erzwungenes NOTHING, keine Konsequenz", async () => {
    db.healthHold.findFirst.mockResolvedValue({ id: "h1" });
    mockPool([
      opt({ id: "a", label: "Strafe", outcomeType: "PENALTY", outcomeJson: JSON.stringify({ text: "x" }) }),
      opt({ id: "b", label: "Orgasmus", outcomeType: "ORGASM_DIRECTIVE", outcomeJson: JSON.stringify({ windowHours: 12 }) }),
    ]);
    const r = await drawFromPool("p1", "sub", { now: NOW, rng: rngFirst });
    if (!r.ok) throw new Error("erwartet ok");
    expect(r.data.outcomeType).toBe("NOTHING");
    expect(db.strafeRecord.create).not.toHaveBeenCalled();
    expect(mOrgasm).not.toHaveBeenCalled();
    // die Ziehung wird trotzdem protokolliert (Rad landet auf einem Label)
    expect(db.zufallsZiehung.create).toHaveBeenCalledTimes(1);
  });
});
