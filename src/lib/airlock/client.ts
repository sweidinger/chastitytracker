import "server-only";
import { resolveAirlockAccess } from "./config";
import type {
  AirlockOut,
  AirlockStatus,
  AirlockVerifyResult,
  AirlockCallResult,
} from "./types";

/**
 * Airlock-NFC — server-seitiger Client gegen die Airlock-`/v1/airlocks*`-API (Weg A). Hält KEINE
 * Secrets im Modul: baseUrl + entschlüsselter KG-Key kommen pro Aufruf aus `resolveAirlockAccess()`.
 * `server-only` verhindert, dass diese Datei je in ein Client-Bundle rutscht (der Key darf nie ins
 * Frontend — Kette Frontend → KG-Backend → Airlock-API). Siehe docs/AIRLOCK_NFC.md.
 *
 * Jeder Aufruf liefert ein `AirlockCallResult<T>`, das drei Zustände trennt (ok / nicht erreichbar /
 * HTTP-Fehler), damit das Frontend „Airlock nicht erreichbar" von „Airlock lehnte ab" unterscheiden
 * kann. Wirft nie — Netzfehler werden zu `unreachable:true`.
 */

const DEFAULT_TIMEOUT_MS = 10_000;

function timeoutMs(): number {
  const n = Number(process.env.AIRLOCK_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_TIMEOUT_MS;
}

/** Ein Airlock-Status, in dem ein Lock NICHT mehr frei zuweisbar ist. */
const UNAVAILABLE_STATUSES: ReadonlySet<AirlockStatus> = new Set<AirlockStatus>([
  "active",
  "retired",
  "voided",
]);

interface RequestOptions {
  method?: "GET" | "PATCH" | "POST";
  /** an den baseUrl angehängter Pfad, mit führendem Slash, z.B. "/v1/airlocks". */
  path: string;
  body?: unknown;
  /** akzeptierte Nicht-2xx-Codes, die der Aufrufer selbst interpretiert (z.B. 404 bei getLock). */
  allowStatuses?: number[];
}

/**
 * Kernaufruf: löst Zugangsdaten auf, setzt den Key-Header (`X-API-Key`), timeoutet und mappt Fehler
 * auf `AirlockCallResult`. `allowStatuses` lässt bewusste Nicht-2xx (404/409/422) als `ok:false,
 * status` durch, ohne sie als „unreachable" zu behandeln.
 */
async function request<T>(opts: RequestOptions): Promise<AirlockCallResult<T>> {
  const access = await resolveAirlockAccess();
  if (!access) {
    return { ok: false, unreachable: true, message: "Airlock ist nicht konfiguriert (keine URL oder kein API-Key)." };
  }

  const url = `${access.baseUrl}${opts.path}`;
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        "X-API-Key": access.apiKey,
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs()),
    });

    if (!res.ok && !(opts.allowStatuses ?? []).includes(res.status)) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        unreachable: false,
        status: res.status,
        message: `Airlock antwortete HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
      };
    }

    // 204 / leerer Body sauber behandeln.
    const raw = await res.text();
    const data = (raw ? JSON.parse(raw) : null) as T;
    return { ok: true, data };
  } catch (e) {
    // Timeout, DNS, Verbindungsabbruch, ungültiges JSON → als nicht erreichbar behandeln.
    return { ok: false, unreachable: true, message: `Airlock nicht erreichbar: ${(e as Error).message}` };
  }
}

/** Ist ein Lock frei zuweisbar? Tag gebunden (nfc_uid ≠ null) UND Status noch frei. */
export function isLockAvailable(lock: AirlockOut): boolean {
  return !!lock.nfc_uid && !UNAVAILABLE_STATUSES.has(lock.status);
}

/**
 * Verbindungstest: ein leichter GET gegen die Lock-Liste. Erfolg = Airlock erreichbar UND Key
 * akzeptiert. Gibt zusätzlich die Anzahl gefundener Locks zurück (für das kleine Log-Fenster im UI).
 */
export async function testConnection(): Promise<AirlockCallResult<{ count: number }>> {
  const res = await request<AirlockOut[]>({ path: "/v1/airlocks" });
  if (!res.ok) return res;
  const count = Array.isArray(res.data) ? res.data.length : 0;
  return { ok: true, data: { count } };
}

/** Alle Locks (roh). */
export async function listLocks(): Promise<AirlockCallResult<AirlockOut[]>> {
  const res = await request<AirlockOut[]>({ path: "/v1/airlocks" });
  if (!res.ok) return res;
  return { ok: true, data: Array.isArray(res.data) ? res.data : [] };
}

/**
 * Nur die verfügbaren (gedruckt, getaggt, frei) Locks. Nutzt den v1.6.0-Filter `?available=true`,
 * filtert das Ergebnis aber ZUSÄTZLICH client-seitig (`isLockAvailable`) — so ist es auf v1.5.0
 * (ohne Filter, liefert alle) genauso korrekt wie auf v1.6.0.
 */
export async function listAvailableLocks(): Promise<AirlockCallResult<AirlockOut[]>> {
  const res = await request<AirlockOut[]>({ path: "/v1/airlocks?available=true" });
  if (!res.ok) return res;
  const list = Array.isArray(res.data) ? res.data : [];
  return { ok: true, data: list.filter(isLockAvailable) };
}

/** Ein Lock per Code. 404 → `ok:false, status:404` (Aufrufer behandelt „unbekannter Code"). */
export async function getLock(code: string): Promise<AirlockCallResult<AirlockOut>> {
  return request<AirlockOut>({ path: `/v1/airlocks/${encodeURIComponent(code)}`, allowStatuses: [404] });
}

/** Statuswechsel (z.B. auf `active` beim Zuweisen/Verschliessen, `retired` beim Freigeben). */
export async function setStatus(
  code: string,
  status: AirlockStatus,
): Promise<AirlockCallResult<AirlockOut>> {
  return request<AirlockOut>({
    method: "PATCH",
    path: `/v1/airlocks/${encodeURIComponent(code)}`,
    body: { status },
    allowStatuses: [404, 422],
  });
}

/**
 * Echtheit + UID-Bindung + Status prüfen. `requireStatus` (ab Airlock v1.6.0) lässt die Airlock-App
 * zusätzlich „muss im Status X sein" erzwingen; auf v1.5.0 wird der Parameter ignoriert und der
 * Aufrufer prüft den Status aus `result.status` selbst. Die UID sollte VOR dem Aufruf mit
 * `canonicalUid()` normalisiert werden (uid.ts).
 */
export async function verify(
  code: string,
  uid: string,
  token: string,
  requireStatus?: AirlockStatus,
): Promise<AirlockCallResult<AirlockVerifyResult>> {
  return request<AirlockVerifyResult>({
    method: "POST",
    path: `/v1/airlocks/${encodeURIComponent(code)}/nfc/verify`,
    body: { uid, token, ...(requireStatus ? { require_status: requireStatus } : {}) },
    allowStatuses: [404, 422],
  });
}
