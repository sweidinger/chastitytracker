import { prisma } from "@/lib/prisma";
import { encrypt, decrypt } from "@/lib/encrypt";

/**
 * Airlock-NFC — instanzweite Verbindungs-Config (Singleton-Zeile `AirlockConfig#singleton`).
 *
 * Der KG-Tracker hält den eingeschränkten `AIRLOCK_KG_API_KEY` AES-256-GCM-verschlüsselt in der DB
 * (nicht in `.env` — bewusste Entscheidung, analog zum Anthropic-Key der AI-Keyholderin). Der Key
 * wird NIE im Klartext ans Frontend gegeben; GET-Routen liefern nur `apiKeySet`. Alle Airlock-
 * Aufrufe laufen server-seitig (Kette Frontend → KG-Backend → Airlock-API). Siehe docs/AIRLOCK_NFC.md.
 */

const SINGLETON_ID = "singleton";

/** Was das Frontend sehen darf: nie den (verschlüsselten) Key, nur ob einer gesetzt ist. */
export interface AirlockConfigSafe {
  enabled: boolean;
  baseUrl: string | null;
  apiKeySet: boolean;
}

/** Entschlüsselte Zugangsdaten für den server-seitigen Client. */
export interface AirlockAccess {
  baseUrl: string;
  apiKey: string;
}

/** Rohzeile lesen (nur server-intern — enthält den verschlüsselten Key). */
async function getRow() {
  return prisma.airlockConfig.findUnique({ where: { id: SINGLETON_ID } });
}

/** Frontend-sichere Sicht auf die Config. Env-Fallbacks (AIRLOCK_BASE_URL / AIRLOCK_KG_API_KEY)
 *  zählen als „gesetzt", damit eine rein per Env konfigurierte Instanz nicht als leer erscheint. */
export async function getAirlockConfigSafe(): Promise<AirlockConfigSafe> {
  const row = await getRow();
  const baseUrl = row?.baseUrl ?? process.env.AIRLOCK_BASE_URL ?? null;
  const apiKeySet = !!row?.apiKeyEnc || !!process.env.AIRLOCK_KG_API_KEY;
  return { enabled: row?.enabled ?? false, baseUrl, apiKeySet };
}

/** Config schreiben (Upsert der Singleton-Zeile). `apiKey`: undefined = unverändert,
 *  "" = gespeicherten Key löschen, sonst verschlüsselt ablegen. `baseUrl` wird rechts getrimmt
 *  (kein Slash am Ende), damit der Client `${baseUrl}/v1/...` sauber zusammensetzt. */
export async function saveAirlockConfig(patch: {
  enabled?: boolean;
  baseUrl?: string | null;
  apiKey?: string;
}): Promise<AirlockConfigSafe> {
  const data: Record<string, unknown> = {};
  if (patch.enabled !== undefined) data.enabled = patch.enabled;
  if ("baseUrl" in patch) {
    const v = (patch.baseUrl ?? "").trim().replace(/\/+$/, "");
    data.baseUrl = v === "" ? null : v;
  }
  if ("apiKey" in patch && patch.apiKey !== undefined) {
    data.apiKeyEnc = patch.apiKey === "" ? null : encrypt(patch.apiKey);
  }

  await prisma.airlockConfig.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, ...data },
    update: data,
  });
  return getAirlockConfigSafe();
}

/**
 * Entschlüsselte Zugangsdaten für den Client, oder null wenn nicht nutzbar (kein baseUrl / kein Key).
 * DB hat Vorrang, Env ist Fallback. Prüft NICHT `enabled` — das ist Sache des Aufrufers (das
 * „Verbindung testen" soll auch bei noch nicht aktivierter Config funktionieren).
 */
export async function resolveAirlockAccess(): Promise<AirlockAccess | null> {
  const row = await getRow();
  const baseUrl = (row?.baseUrl ?? process.env.AIRLOCK_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) return null;

  let apiKey = process.env.AIRLOCK_KG_API_KEY ?? "";
  if (row?.apiKeyEnc) {
    try {
      apiKey = decrypt(row.apiKeyEnc);
    } catch {
      // Falscher/rotierter DB_ENCRYPTION_KEY: nicht crashen — als „kein Key" behandeln, der Aufrufer
      // meldet dann einen sauberen Fehlerzustand ans Frontend.
      apiKey = "";
    }
  }
  if (!apiKey) return null;
  return { baseUrl, apiKey };
}

/** Ist Airlock scharf? = Config aktiviert UND nutzbare Zugangsdaten vorhanden. Gate für die Flows
 *  (Verschluss-/Kontroll-Integration zeigt Airlock nur, wenn hier true). */
export async function airlockEnabled(): Promise<boolean> {
  const row = await getRow();
  if (!row?.enabled) return false;
  return (await resolveAirlockAccess()) !== null;
}
