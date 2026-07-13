import { prisma } from "@/lib/prisma";
import { buildStrafbuch, type StrafbuchData } from "@/lib/strafbuch";
import { notifyUser } from "@/lib/notify";
import { executePenaltyAction, type PenaltyAction } from "@/lib/penaltyActions";
import { bestaetigeErledigung, lehneErledigungAb } from "@/lib/strafErledigung";
import type { ServiceResult } from "@/lib/serviceResult";

/**
 * Urteils-Lebenszyklus über erkannte Vergehen:
 *   erkannt → verworfen (DISMISSED) | bestraft (PUNISHED) → erledigt.
 * Single source of truth, geteilt von der Admin-Strafbuch-Route und dem MCP-Tool judge_offense.
 *
 * Die Strafe ist ein freies Textfeld (z.B. „20 Schläge") — kein Typen-Zoo, keine Sperrzeit-Kopplung.
 * Die Klugheit liegt im Urteilstext, nicht im Feld. „erledigtAt" schließt den Loop.
 */

/** MCP-kanonischer Vergehenstyp ↔ gespeicherter offenseType. */
export type OffenseCanonicalType =
  | "unauthorized_opening"
  | "late_control"
  | "rejected_control"
  | "wrong_device"
  | "missed_orgasm"
  | "missed_session"
  | "missed_lock"
  | "erektion"
  | "pause_overage";

const STORED_TYPE: Record<OffenseCanonicalType, string> = {
  unauthorized_opening: "OEFFNEN_ENTRY",
  late_control: "KONTROLLANFORDERUNG",
  rejected_control: "KONTROLLANFORDERUNG",
  wrong_device: "FALSCHES_GERAET",
  missed_orgasm: "ORGASMUS_ANWEISUNG",
  missed_session: "SESSION_VERSAEUMT",
  missed_lock: "VERSCHLUSS_ANFORDERUNG",
  erektion: "EREKTION",
  pause_overage: "PAUSE_OVERAGE",
};

/** Schwere-Stufe eines Vergehens. Phase 1: Basis-Schwere (Wiederholungs-Eskalation folgt in Phase 2). */
export type OffenseSeverity = "leicht" | "mittel" | "schwer";

/** Basis-Schwere je Vergehenstyp (vereinbarte Kategorisierung). */
export const OFFENSE_SEVERITY: Record<OffenseCanonicalType, OffenseSeverity> = {
  unauthorized_opening: "schwer",
  wrong_device: "schwer",
  rejected_control: "schwer",
  missed_lock: "mittel",
  missed_session: "mittel",
  missed_orgasm: "mittel",
  late_control: "mittel",
  pause_overage: "leicht",
  erektion: "leicht",
};

/** Sortier-Rang: schwer zuerst. */
export const SEVERITY_RANK: Record<OffenseSeverity, number> = { schwer: 0, mittel: 1, leicht: 2 };

/** Ein anklickbarer Straf-Vorschlag: Text + optionale Aktion, die beim Bestrafen ausgeführt wird. */
export interface PenaltySuggestion {
  label: string;
  /** Aktion, die beim „Strafe verhängen" mit ausgeführt wird (fehlt = reiner Text). */
  action?: PenaltyAction["type"];
  /** Numerisches Pflichtfeld der Aktion (z.B. Stunden der Verlängerung, Fenster/Frist). */
  param?: { field: "hours" | "windowHours"; label: string; default: number };
}

/** Anklickbare Straf-Vorschläge je Stufe — Chip = Text + (optional) Aktion. Orientierung, NICHT bindend.
 *  Leitlinie: ruinierter Orgasmus (Pflicht) & "Session anfordern" = Strafe; ein normaler Orgasmus
 *  (Gelegenheit/Erlaubnis, Masturbation) = Belohnung und wird NIE als Strafe vergeben. */
export const SEVERITY_PENALTY_SUGGESTIONS: Record<OffenseSeverity, PenaltySuggestion[]> = {
  leicht: [
    { label: "Ermahnung / freundliche Verwarnung" },
    { label: "Kurze Reflexion (1–2 Sätze, was nächstes Mal besser läuft)" },
    { label: "Sperrzeit verlängern (nur bei Wiederholung)", action: "extend_lock", param: { field: "hours", label: "Stunden Verlängerung", default: 1 } },
  ],
  mittel: [
    { label: "Extra-Kontrolle anfordern", action: "extra_control" },
    { label: "Sperrzeit verlängern", action: "extend_lock", param: { field: "hours", label: "Stunden Verlängerung", default: 3 } },
    { label: "Ruinierter Orgasmus (Pflicht)", action: "ruined_orgasm", param: { field: "windowHours", label: "Fenster (Stunden)", default: 24 } },
    { label: "Nächste Orgasmus-Gelegenheit verschieben", action: "delay_orgasm", param: { field: "hours", label: "Stunden verschieben", default: 3 } },
    { label: "Nächstgrößeren Analplug anfordern", action: "bigger_plug" },
  ],
  schwer: [
    { label: "Sperrzeit verlängern", action: "extend_lock", param: { field: "hours", label: "Stunden Verlängerung", default: 5 } },
    { label: "Ruinierter Orgasmus (Pflicht)", action: "ruined_orgasm", param: { field: "windowHours", label: "Fenster (Stunden)", default: 24 } },
    { label: "Orgasmus-Entzug: Belohnungs-Guthaben −1", action: "deny_orgasm" },
    { label: "Pflicht-Session anfordern", action: "mandatory_session", param: { field: "windowHours", label: "Frist (Stunden)", default: 24 } },
  ],
};

/** Kompakter Leitlinien-Text zur Schwere + Strafmaß — geteilt vom AI-Kontext und der MCP-Doku. */
export const SEVERITY_GUIDANCE_TEXT = [
  "",
  "--- Schwere & Strafmaß (Orientierung, nicht bindend) ---",
  "Vergehen sind in drei Stufen kategorisiert; wähle das Strafmaß passend zur Stufe:",
  `- SCHWER (unerlaubte Öffnung, falsches Gerät, abgelehnte Kontrolle): ${SEVERITY_PENALTY_SUGGESTIONS.schwer.map((s) => s.label).join(" · ")}`,
  `- MITTEL (versäumte Verschluss-Anforderung, versäumte Session, verpasste Orgasmus-Anweisung, zu spät erfüllte Kontrolle): ${SEVERITY_PENALTY_SUGGESTIONS.mittel.map((s) => s.label).join(" · ")}`,
  `- LEICHT (Pause zu lang, Erektion): ${SEVERITY_PENALTY_SUGGESTIONS.leicht.map((s) => s.label).join(" · ")}`,
  "Wiederholung: dasselbe Vergehen ≥5× in 7 Tagen (bzw. eine ignorierte Straf-Anweisung ≥2×) hebt die Schwere automatisch an — im Ledger als `escalated`/`severity` erkennbar. Bemiss die Strafe an der effektiven (hochgestuften) Schwere.",
  "Leitlinie: ein ruinierter Orgasmus (Pflicht) und eine angeordnete Session sind STRAFEN; ein normaler Orgasmus (Gelegenheit/Erlaubnis, Masturbation) ist eine BELOHNUNG und wird NIE als Strafe vergeben.",
].join("\n");

export interface DetectedOffense {
  canonicalType: OffenseCanonicalType;
  offenseType: string;
  refId: string;
  at: Date | null;
}

/** Flacht die buildStrafbuch-Listen zu einer einheitlichen Liste erkannter Vergehen mit stabiler ref.
 *  Dient der ref-Auflösung (judge_offense) und dem Zählen — keine Strafwertung. */
export function collectDetectedOffenses(sb: StrafbuchData): DetectedOffense[] {
  const mk = (canonicalType: OffenseCanonicalType, refId: string, at: Date | null): DetectedOffense =>
    ({ canonicalType, offenseType: STORED_TYPE[canonicalType], refId, at });
  return [
    ...sb.unauthorizedOpenings.map((o) => mk("unauthorized_opening", o.id, o.startTime)),
    ...sb.lateControls.map((k) => mk("late_control", k.id, k.entryStartTime ?? k.deadline)),
    ...sb.rejectedControls.map((k) => mk("rejected_control", k.id, k.entryStartTime ?? k.deadline)),
    ...sb.wrongDeviceViolations.map((v) => mk("wrong_device", v.entryId, v.startTime)),
    ...sb.erektionViolations.map((v) => mk("erektion", v.entryId, v.startTime)),
    ...sb.pauseOverageViolations.map((v) => mk("pause_overage", v.entryId, v.startTime)),
    ...sb.missedOrgasmInstructions.map((m) => mk("missed_orgasm", m.id, m.endetAt)),
    ...sb.missedSessions.map((m) => mk("missed_session", m.id, m.endetAt)),
    ...sb.missedLockRequests.map((m) => mk("missed_lock", m.id, m.endetAt)),
  ];
}

/** Effektive Schwere eines Vergehens inkl. Wiederholungs-Eskalation. */
export interface EffectiveSeverity {
  severity: OffenseSeverity;
  base: OffenseSeverity;
  escalated: boolean;
}

const ESCALATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** ≥5× dasselbe Vergehen / 7 Tage → eine Stufe hoch. */
const REPEAT_THRESHOLD = 5;
/** Ignorierte Straf-Anweisung (ruinierter Orgasmus als Pflicht) ≥2× / 7 Tage → schwer. */
const PENALTY_REPEAT_THRESHOLD = 2;

function nextSeverity(s: OffenseSeverity): OffenseSeverity {
  return s === "leicht" ? "mittel" : "schwer";
}

/** Berechnet je erkanntem Vergehen (refId) die EFFEKTIVE Schwere. Zählfenster: die letzten 7 Tage
 *  ab `now`. Regeln: dasselbe Vergehen ≥5× → +1 Stufe; ignorierte Straf-Anweisung ≥2× → schwer. */
export function computeSeverities(sb: StrafbuchData, now: Date = new Date()): Map<string, EffectiveSeverity> {
  const offenses = collectDetectedOffenses(sb);
  const windowStart = now.getTime() - ESCALATION_WINDOW_MS;
  // Ignorierte Straf-ANWEISUNGEN (als Strafe angeordnete Orgasmus-Anweisungen ODER Pflicht-Sessions).
  const penaltyRefIds = new Set<string>([
    ...sb.missedOrgasmInstructions.filter((m) => m.istStrafe).map((m) => m.id),
    ...sb.missedSessions.filter((m) => m.istStrafe).map((m) => m.id),
  ]);
  const inWindow = (o: DetectedOffense) => (o.at ? o.at.getTime() : 0) >= windowStart;

  const countByType = new Map<OffenseCanonicalType, number>();
  let penaltyDirectiveCount = 0;
  for (const o of offenses) {
    if (!inWindow(o)) continue;
    countByType.set(o.canonicalType, (countByType.get(o.canonicalType) ?? 0) + 1);
    if (penaltyRefIds.has(o.refId)) penaltyDirectiveCount++;
  }

  const result = new Map<string, EffectiveSeverity>();
  for (const o of offenses) {
    const base = OFFENSE_SEVERITY[o.canonicalType];
    let eff = base;
    if ((countByType.get(o.canonicalType) ?? 0) >= REPEAT_THRESHOLD) eff = nextSeverity(eff);
    // Ignorierte Straf-Anweisung (Orgasmus/Session) ≥2× / 7 Tage → schwer.
    if (penaltyRefIds.has(o.refId) && penaltyDirectiveCount >= PENALTY_REPEAT_THRESHOLD) eff = "schwer";
    result.set(o.refId, { severity: eff, base, escalated: eff !== base });
  }
  return result;
}

export interface JudgeOffenseParams {
  userId: string;
  refId: string;
  action: "dismiss" | "punish" | "complete" | "reopen" | "reject_completion";
  /** Freitext: Strafe (bei punish, erforderlich), Grund (bei dismiss, optional) bzw.
   *  Begründung der Ablehnung (bei reject_completion, erforderlich). */
  text?: string;
  judgedBy: "ai" | "admin";
  /** Optionale Straf-Aktion (Phase 3): wird bei action="punish" direkt ausgeführt. */
  penaltyAction?: PenaltyAction | null;
}

export interface JudgeOffenseResult {
  status: "punished" | "dismissed" | "open";
  done: boolean;
  /** Ergebnis der ausgeführten Straf-Aktion (falls eine mitgegeben wurde). */
  actionMessage?: string | null;
  actionError?: string | null;
}

/**
 * Fällt/aktualisiert ein Urteil über ein erkanntes Vergehen (per refId).
 * - dismiss: markiert DISMISSED (verbindlich), text = optionaler Grund.
 * - punish: markiert PUNISHED, text = Strafe (erforderlich), erledigtAt = null (offen).
 * - complete: setzt erledigtAt = now auf einer bestehenden Strafe (Loop schließen).
 * - reopen: entfernt das Urteil (revidieren).
 */
/** Betreff + Text der „Strafe verhängt"-Benachrichtigung — geteilt von judgeOffense (MCP) und
 *  der Admin-Strafe-Route, damit beide Wege identisch benachrichtigen. */
export function strafeVerhaengtNotice(reason: string | null): { subject: string; message: string } {
  return {
    subject: "Strafe verhängt",
    message: reason ? `Der Keyholder hat eine Strafe verhängt: ${reason}` : "Der Keyholder hat eine Strafe verhängt.",
  };
}

export async function judgeOffense(p: JudgeOffenseParams): Promise<ServiceResult<JudgeOffenseResult>> {
  const now = new Date();

  if (p.action === "reopen") {
    const del = await prisma.strafeRecord.deleteMany({ where: { userId: p.userId, refId: p.refId } });
    if (del.count === 0) return { ok: false, status: 404, error: "Kein Urteil zu diesem Vergehen gefunden." };
    return { ok: true, data: { status: "open", done: false } };
  }

  // Erledigung bestätigen (schließt den Loop). Liegt eine Meldung des Subs vor, wird er benachrichtigt.
  if (p.action === "complete") {
    const rec = await prisma.strafeRecord.findUnique({ where: { refId: p.refId } });
    if (!rec || rec.userId !== p.userId) return { ok: false, status: 404, error: "Kein Urteil zu diesem Vergehen gefunden." };
    if (rec.status !== "PUNISHED") return { ok: false, status: 400, error: "Nur eine verhängte Strafe kann erledigt werden." };
    if (!rec.erledigtAt) {
      const res = await bestaetigeErledigung(p.userId, p.refId);
      if (!res.ok) return res;
    }
    return { ok: true, data: { status: "punished", done: true } };
  }

  // Gemeldete Erledigung ablehnen → Strafe ist wieder offen, der Sub erfährt den Grund.
  if (p.action === "reject_completion") {
    const res = await lehneErledigungAb(p.userId, p.refId, p.text ?? "");
    if (!res.ok) return res;
    return { ok: true, data: { status: "punished", done: false } };
  }

  const text = p.text?.trim() || null;
  if (p.action === "punish" && !text) return { ok: false, status: 400, error: "Eine Strafe (text) ist erforderlich." };

  // Vergehen muss aktuell erkannt sein (verhindert Urteile über Nicht-Vergehen).
  const offenses = collectDetectedOffenses(await buildStrafbuch(p.userId, now));
  const offense = offenses.find((o) => o.refId === p.refId);
  if (!offense) return { ok: false, status: 404, error: `Kein offenes Vergehen mit ref ${p.refId}.` };

  const status = p.action === "punish" ? "PUNISHED" : "DISMISSED";
  await prisma.strafeRecord.upsert({
    where: { refId: p.refId },
    create: { userId: p.userId, offenseType: offense.offenseType, refId: p.refId, bestraftDatum: now, status, reason: text, judgedBy: p.judgedBy, erledigtAt: null },
    update: { status, reason: text, judgedBy: p.judgedBy, erledigtAt: null, bestraftDatum: now },
  });

  // Nur bei verhängter Strafe benachrichtigen (ein Verwerfen ist für den Nutzer belanglos).
  if (status === "PUNISHED") await notifyUser(p.userId, strafeVerhaengtNotice(text));

  // Straf-Aktion (Phase 3) ausführen — nur bei verhängter Strafe. Fehler brechen das Urteil NICHT ab.
  let actionMessage: string | null = null;
  let actionError: string | null = null;
  if (status === "PUNISHED" && p.penaltyAction) {
    const ar = await executePenaltyAction(p.userId, p.penaltyAction);
    if (ar.ok) actionMessage = ar.data.message;
    else actionError = ar.error;
  }

  return { ok: true, data: { status: status === "PUNISHED" ? "punished" : "dismissed", done: false, actionMessage, actionError } };
}
