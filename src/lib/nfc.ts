// Airlock-NFC — Web-Seite des nativen NFC-Plugins. Alle Capacitor-Module werden DYNAMISCH importiert,
// damit nichts auf dem Server oder im reinen Browser ohne Bridge bricht (gleiches Muster wie
// nativePush.ts). Das native Plugin (ios/App/App/Nfc.swift) liefert { uid, ndefText }; Kanonisierung
// und Verifikation passieren danach web-/serverseitig (Weg A, siehe docs/AIRLOCK_NFC.md).

export interface NfcScanResult {
  /** Hardware-UID (Hex, Grossbuchstaben, ohne Trenner) — noch NICHT kanonisiert. */
  uid: string;
  /** NDEF-Text-Record, erwartet `AL1|<code>|<token>`. */
  ndefText: string;
}

/** Fehler-/Zustands-Codes, die das native Plugin bzw. der Wrapper zurückgeben können. */
export type NfcScanError =
  | "not-native"        // kein Capacitor-Native-Kontext (Web/Server) → Scan nicht möglich
  | "NFC_UNAVAILABLE"   // Gerät kann kein NFC (älter als iPhone 7 / iOS < 13)
  | "NFC_CANCELLED"     // Nutzer hat den Scan abgebrochen
  | "NFC_CONNECT_FAILED"
  | "NFC_NOT_NTAG"
  | "NFC_NDEF_FAILED"
  | "NFC_ERROR";

interface NfcPlugin {
  isAvailable(): Promise<{ available: boolean }>;
  scan(options?: { alertMessage?: string }): Promise<NfcScanResult>;
}

/** Lädt das registrierte native Plugin (nur im Native-Kontext sinnvoll). */
async function getPlugin(): Promise<{ Nfc: NfcPlugin; isNative: boolean } | null> {
  try {
    const { Capacitor, registerPlugin } = await import("@capacitor/core");
    const Nfc = registerPlugin<NfcPlugin>("Nfc");
    return { Nfc, isNative: Capacitor.isNativePlatform() };
  } catch {
    return null;
  }
}

/** Ist auf diesem Gerät NFC-Lesen verfügbar? (false im Web/Server oder auf Geräten ohne NFC.) */
export async function isNfcAvailable(): Promise<boolean> {
  const p = await getPlugin();
  if (!p || !p.isNative) return false;
  try {
    const r = await p.Nfc.isAvailable();
    return !!r.available;
  } catch {
    return false;
  }
}

export type NfcScanOutcome =
  | { ok: true; data: NfcScanResult }
  | { ok: false; error: NfcScanError; detail?: string };

/**
 * Startet einen NFC-Scan und liefert { uid, ndefText }. Wirft NIE — Fehler kommen als typisiertes
 * `{ ok: false, error }` zurück (inkl. `not-native` im Browser), damit die UI sauber reagieren kann.
 */
export async function scanNfcTag(alertMessage?: string): Promise<NfcScanOutcome> {
  const p = await getPlugin();
  if (!p) return { ok: false, error: "not-native" };
  if (!p.isNative) return { ok: false, error: "not-native" };
  try {
    const data = await p.Nfc.scan(alertMessage ? { alertMessage } : undefined);
    return { ok: true, data };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    const code = (err.code as NfcScanError) || "NFC_ERROR";
    return { ok: false, error: code, detail: err.message };
  }
}
