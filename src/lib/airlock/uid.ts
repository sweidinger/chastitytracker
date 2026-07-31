/**
 * Airlock-NFC — UID- und NDEF-Helfer (Leseseite, Weg A).
 *
 * Der KG-Tracker prüft NICHT selbst die Signatur (das macht die Airlock-`verify`-API). Er muss aber
 * die vom Tag gelesene UID in die EINE kanonische Reihenfolge bringen, in der der Token beim
 * Schreiben gebunden wurde — sonst schlägt die Airlock-Signaturprüfung fehl, obwohl der Tag echt ist
 * (dokumentierter iOS↔Android-Bug: „It's the same UID, it's just reversed"). Siehe docs/AIRLOCK_NFC.md § 3.
 *
 * Bewusst importfrei — dieselbe Regel wie codedError.ts/serviceErrorCodes.ts: so bleibt der Helfer
 * aus Client-Komponenten erreichbar, ohne next/server oder prisma in den Browser-Bundle zu ziehen.
 */

/**
 * Entfernt alle Nicht-Hex-Zeichen und macht Grossbuchstaben — dreht die Byte-Reihenfolge NICHT
 * (das ist genau das Verhalten des Generators, `normalize_uid` in app/nfc.py). Wirft bei einer UID,
 * die nicht 8–20 Hex-Zeichen gerader Länge ist.
 */
export function normalizeUid(uid: string): string {
  const u = (uid || "").replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (u.length < 8 || u.length > 20 || u.length % 2 !== 0) {
    throw new Error(`Ungültige UID: ${uid}`);
  }
  return u;
}

/**
 * Bringt eine gelesene UID in die kanonische Reihenfolge (Byte 0 zuerst = NFC-Übertragungsreihenfolge
 * = die auf dem Tag gebundene Reihenfolge). Heuristik: die UID eines NTAG beginnt IMMER mit `04`
 * (NXP-Herstellercode). Beginnt die normalisierte UID nicht mit `04`, ist die Byte-Reihenfolge
 * vermutlich gedreht (iOS/Core-NFC bzw. manche Android-Libs) → paarweise Bytes umkehren.
 *
 * Grenzfall: dreht man eine bereits korrekte UID, die zufällig auf `04` endet, könnte die Heuristik
 * theoretisch danebenliegen — deshalb einmal beim ersten Hardware-Test gegen einen echten,
 * generator-beschriebenen Tag verifizieren (docs/AIRLOCK_NFC.md § 3, letzter Hinweis).
 */
export function canonicalUid(rawHex: string): string {
  const u = normalizeUid(rawHex);
  if (u.startsWith("04")) return u;
  const bytes = u.match(/.{2}/g);
  if (!bytes) return u; // normalizeUid garantiert gerade Länge → nie null, nur zur Typ-Beruhigung
  return bytes.reverse().join("");
}

/** Ergebnis eines geparsten NDEF-Text-Records. */
export interface ParsedNdef {
  code: string;
  token: string;
}

/**
 * Zerlegt den NDEF-Text-Record `AL1|<code>|<token>` in `code` + `token`. Gibt `null` zurück, wenn er
 * nicht dem Format entspricht (nicht genau 3 Teile oder Präfix ≠ "AL1"). Entspricht `parse_ndef_text`
 * im Generator.
 */
export function parseNdef(text: string): ParsedNdef | null {
  const p = (text || "").trim().split("|");
  return p.length === 3 && p[0] === "AL1" ? { code: p[1], token: p[2] } : null;
}
