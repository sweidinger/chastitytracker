import "server-only";
import { prisma } from "@/lib/prisma";
import { canonicalUid, parseNdef } from "./uid";
import { verify as apiVerify } from "./client";
import { getAssignedLocks } from "./service";
import type { AirlockStatus } from "./types";

/**
 * Airlock-NFC — Nachweis-Prüfung für die Flows (Verschluss erfassen, Kontrolle). Weg A: die Signatur
 * prüft die Airlock-`verify`-API, hier wird nur die UID kanonisiert, die API gerufen und das Ergebnis
 * auf stabile Fehler-Codes gemappt (die die Entry-Route 1:1 an den Client zurückgibt). Siehe
 * docs/AIRLOCK_NFC.md § 4.5/4.6.
 */

/** Stabile Fehler-Codes; müssen in entryErrors.ts (ENTRY_ROUTE_CODES) + messages/{de,en}.json stehen. */
export type AirlockProofError =
  | "AIRLOCK_NOT_REACHABLE"
  | "AIRLOCK_TAG_INVALID"
  | "AIRLOCK_TAG_UID_MISMATCH"
  | "AIRLOCK_TAG_NOT_REGISTERED"
  | "AIRLOCK_TAG_RETIRED"
  | "AIRLOCK_WRONG_LOCK";

/** Roh-Eingabe vom Tag: entweder code+token einzeln, oder der NDEF-Text `AL1|code|token`.
 *  `uid` kommt IMMER aus der Hardware-Identifikation (nicht aus dem NDEF-Inhalt). */
export interface AirlockProofInput {
  uid: string;
  code?: string;
  token?: string;
  ndefText?: string;
}

export interface AirlockProofOk {
  ok: true;
  code: string;
  /** kanonische UID (wie beim Schreiben gebunden) — Anker für die spätere Kontrolle */
  uid: string;
  status: AirlockStatus | null;
  boundUid: string | null;
}
export type AirlockProofResult = AirlockProofOk | { ok: false; error: AirlockProofError };

/** Zerlegt die Eingabe in code+token (direkt oder aus dem NDEF-Text). null = unlesbar/unvollständig. */
function resolveCodeToken(input: AirlockProofInput): { code: string; token: string } | null {
  if (input.code && input.token) return { code: input.code, token: input.token };
  if (input.ndefText) {
    const p = parseNdef(input.ndefText);
    if (p) return p;
  }
  return null;
}

/**
 * Prüft einen rohen Tag-Nachweis gegen die Airlock-API. Prüft NICHT den Status „active" (ein frisch
 * zu verschliessendes Lock ist noch nicht active) — nur Echtheit, UID-Bindung und Registrierung.
 * `bound_uid == null` (echt, aber nie committed) wird für starken Kopierschutz abgelehnt (§ 4.6).
 */
export async function verifyProof(input: AirlockProofInput): Promise<AirlockProofResult> {
  const parsed = resolveCodeToken(input);
  if (!parsed) return { ok: false, error: "AIRLOCK_TAG_INVALID" };

  let uid: string;
  try {
    uid = canonicalUid(input.uid);
  } catch {
    return { ok: false, error: "AIRLOCK_TAG_INVALID" };
  }

  const res = await apiVerify(parsed.code, uid, parsed.token);
  if (!res.ok) {
    return { ok: false, error: res.unreachable ? "AIRLOCK_NOT_REACHABLE" : "AIRLOCK_TAG_INVALID" };
  }

  const v = res.data;
  if (!v.valid) {
    switch (v.reason) {
      case "uid_mismatch":
        return { ok: false, error: "AIRLOCK_TAG_UID_MISMATCH" };
      case "status_retired":
      case "status_voided":
        return { ok: false, error: "AIRLOCK_TAG_RETIRED" };
      default:
        return { ok: false, error: "AIRLOCK_TAG_INVALID" };
    }
  }

  // valid:true, aber nie committed → echt, doch nicht registriert. Für starken Kopierschutz ablehnen.
  if (v.bound_uid == null) return { ok: false, error: "AIRLOCK_TAG_NOT_REGISTERED" };

  return { ok: true, code: parsed.code, uid, status: v.status ?? null, boundUid: v.bound_uid ?? null };
}

/**
 * Nachweis für „Verschluss erfassen". Zusätzlich zur Echtheit:
 *  - Gehört das gescannte Lock bereits einem ANDEREN Sub → abgelehnt.
 *  - Gibt die Anforderung ein Lock vor (`mandatedCode`) → es muss GENAU dieses sein.
 *  - Hat der Sub einen Pool (≥1 zugewiesenes Lock) → das gescannte muss eines daraus sein.
 *  - Hat der Sub KEINE Zuweisung → jedes echte Lock wird akzeptiert (eigenständiger Verschluss, optional).
 */
export async function verifyForVerschluss(
  userId: string,
  input: AirlockProofInput,
  mandatedCode?: string | null,
): Promise<AirlockProofResult> {
  const res = await verifyProof(input);
  if (!res.ok) return res;

  // Gehört das gescannte Lock bereits einem ANDEREN Sub? → nicht verwenden.
  const lockRow = await prisma.airlockLock.findUnique({ where: { code: res.code } });
  if (lockRow?.assignedUserId && lockRow.assignedUserId !== userId) {
    return { ok: false, error: "AIRLOCK_WRONG_LOCK" };
  }
  // Vorgabe der Anforderung: genau dieses Lock.
  if (mandatedCode && res.code !== mandatedCode) {
    return { ok: false, error: "AIRLOCK_WRONG_LOCK" };
  }
  // Pool des Subs: gibt es zugewiesene Locks, muss das gescannte eines davon sein.
  const assigned = await getAssignedLocks(userId);
  if (assigned.length > 0 && !assigned.some((l) => l.code === res.code)) {
    return { ok: false, error: "AIRLOCK_WRONG_LOCK" };
  }
  return res;
}

/**
 * Nachweis für „Kontrolle": der gescannte Tag muss dieselbe UID liefern, die beim aktiven Verschluss
 * gebunden wurde (Entry.airlockUid) — sonst wurde ein anderes/kopiertes Lock vorgezeigt.
 */
export async function verifyForKontrolle(
  activeAirlockUid: string,
  input: AirlockProofInput,
): Promise<AirlockProofResult> {
  const res = await verifyProof(input);
  if (!res.ok) return res;
  if (res.uid !== activeAirlockUid) {
    return { ok: false, error: "AIRLOCK_TAG_UID_MISMATCH" };
  }
  return res;
}
