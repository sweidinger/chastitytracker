/**
 * Airlock-NFC — Typen des Airlock-API-Contracts (Weg A). Absichtlich nah an der API-Referenz aus
 * docs/AIRLOCK_NFC.md § 5 gehalten. Der KG-Tracker konsumiert nur einen Teil der Felder; unbekannte
 * Zusatzfelder werden ignoriert (Vorwärtskompatibilität mit künftigen Airlock-Versionen).
 */

/** Status-Lebenszyklus eines Airlocks (SQLite-Registry der Airlock-App). */
export type AirlockStatus =
  | "reserved"
  | "generated"
  | "printed"
  | "registered"
  | "active"
  | "retired"
  | "voided";

/** Ein Lock, wie die Airlock-API es liefert (`GET /v1/airlocks*`). */
export interface AirlockOut {
  code: string;
  status: AirlockStatus;
  source?: string;
  batch_id?: string | null;
  stl_url?: string | null;
  stl_sha256?: string | null;
  created_at?: string;
  /** gebundene Tag-UID (kanonisch) oder null = Tag noch nicht committed/beschrieben. */
  nfc_uid?: string | null;
  nfc_written_at?: string | null;
}

/** Gründe, aus denen `verify` `valid:false` liefert (docs/AIRLOCK_NFC.md § 4.5). */
export type AirlockVerifyReason =
  | "unknown_code"
  | "bad_uid"
  | "bad_signature"
  | "uid_mismatch"
  | "status_retired"
  | "status_voided"
  | "status_mismatch"; // nur mit require_status (ab Airlock v1.6.0)

/** Antwort von `POST /v1/airlocks/{code}/nfc/verify`. */
export interface AirlockVerifyResult {
  valid: boolean;
  reason?: AirlockVerifyReason;
  code?: string;
  uid?: string;
  status?: AirlockStatus;
  /** die für diesen Code registrierte UID; null = Tag echt, aber noch nie committed (§ 4.6). */
  bound_uid?: string | null;
}

/**
 * Ergebnis eines Airlock-Aufrufs im KG-Backend. Trennt bewusst drei Fälle, damit das Frontend einen
 * klaren Zustand zeigen kann (docs/AIRLOCK_NFC.md § 4.5, „Airlock nicht erreichbar"):
 *   ok:true             → data
 *   ok:false, unreachable:true  → Airlock-Instanz nicht erreichbar / Timeout / nicht konfiguriert
 *   ok:false, unreachable:false → Airlock hat geantwortet, aber mit HTTP-Fehler (status gesetzt)
 */
export type AirlockCallResult<T> =
  | { ok: true; data: T }
  | { ok: false; unreachable: boolean; status?: number; message: string };
