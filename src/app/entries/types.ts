/**
 * Shared contracts for entry-form Cores (Orgasmus, Pruefung, Verschluss, Oeffnen).
 *
 * SubmitResult: what each `submitFn` callback returns:
 *   { ok: true }                   → Core calls onSuccess() (caller navigates).
 *   { ok: false, error: string }   → Core displays the error inline.
 *   { ok: true, offline: true }    → caller handled queuing, Core calls onSuccess().
 */

// `import type` — zur Laufzeit gelöscht, zieht also kein Prisma in das Client-Bundle.
import type { NextCleaningWindow } from "@/lib/cleaningService";
import type { CleaningBlockReason } from "@/lib/queries";
export type SubmitResult =
  | { ok: true; offline?: boolean }
  | { ok: false; error: string };

export interface OrgasmusPayload {
  type: "ORGASMUS";
  startTime: string;
  orgasmusArt: string;
  note: string | null;
  /** Optionaler Foto-Nachweis — Pflicht, wenn die offene Anforderung `fotoPflicht` setzt. */
  imageUrl: string | null;
  imageExifTime: string | null;
}

export interface PruefungPayload {
  type: "PRUEFUNG";
  startTime: string;
  imageUrl: string | null;
  imageExifTime: string | null;
  note: string | null;
  kontrollCode: string | null;
  /** Das kontrollierte Gerät — gesetzt bei Trage-Kontrollen (v5.0.1), null beim KG (dort steht das
   *  Gerät am VERSCHLUSS). Es bestimmt zugleich, WELCHE offene Anforderung das Foto beantwortet. */
  deviceId?: string | null;
  /** Clockwise rotation applied to the photo in the form (0|90|180|270).
   *  Server-side AI verify must use the same rotation as the client preview. */
  imageRotation: number;
  /** Zweites Foto durchs Sichtfenster der Box: liegt der Schlüssel noch drin? Nur bei aktiver Box. */
  boxImageUrl?: string | null;
  /** Anzeige-Drehung des Box-Fotos (siehe `imageRotation`). */
  boxImageRotation?: number;
  /** Airlock-NFC: Nachweis vom gescannten Tag (Hardware-UID + NDEF-Text `AL1|code|token`).
   *  Serverseitig verifiziert (Weg A) — bei einem Airlock-Verschluss ersetzt der Scan die Code-Abfrage. */
  airlock?: { uid: string; ndefText: string } | null;
}

export interface VerschlussPayload {
  type: "VERSCHLUSS";
  startTime: string;
  /** Der Träger hat die Zeit nicht angefasst: der Server datiert mit seiner Uhr, auf die Sekunde. */
  startIsNow?: boolean;
  imageUrl: string | null;
  imageExifTime: string | null;
  note: string | null;
  kontrollCode: string | null;
  deviceId: string | null;
  /** Liegt der Schlüssel in der Box? Nur bei aktiver Box gesetzt. `false` = der Sub behält ihn
   *  (Reise o.ä.) — dann verriegelt die Box NICHT: eine leere verschlossene Box meldete sonst einen
   *  Hardware-Hold, während der Schlüssel in seiner Tasche liegt. */
  keyInBox?: boolean;
  /** Bildersafe: versiegeltes Schlüsselbox-Code-Foto (nur wenn Instanz im Bildersafe-Modus). */
  codeImageUrl?: string | null;
  /** Bildersafe: Ziffern im Code-Foto erkannt (Lesbarkeits-✓). */
  codeReadable?: boolean | null;
  /** Airlock-NFC: Nachweis vom gescannten Tag (Hardware-UID + NDEF-Text `AL1|code|token`).
   *  Serverseitig verifiziert (Weg A); optional beim eigenständigen Verschluss, sonst leer. */
  airlock?: { uid: string; ndefText: string } | null;
}

export interface OeffnenPayload {
  type: "OEFFNEN";
  startTime: string;
  /** Der Träger hat die Zeit nicht angefasst: der Server datiert mit seiner Uhr, auf die Sekunde. */
  startIsNow?: boolean;
  oeffnenGrund: string;
  note: string | null;
  /** Only set when user confirmed the Reinigung-limit-bypass sheet. */
  forcedCleaning?: boolean;
  /** True when user reports an erection occurred during REINIGUNG or TOILETTE opening. */
  erektionGemeldet?: boolean;
}

export interface WearBeginPayload {
  type: "WEAR_BEGIN";
  startTime: string;
  /** Der Träger hat die Zeit nicht angefasst: der Server datiert mit seiner Uhr, auf die Sekunde. */
  startIsNow?: boolean;
  deviceId: string;
  imageUrl: string | null;
  imageExifTime: string | null;
  note: string | null;
}

export interface WearEndPayload {
  type: "WEAR_END";
  startTime: string;
  /** Der Träger hat die Zeit nicht angefasst: der Server datiert mit seiner Uhr, auf die Sekunde. */
  startIsNow?: boolean;
  deviceId: string;
  imageUrl: string | null;
  imageExifTime: string | null;
  note: string | null;
}

/** Payload for the Plug "Tragen beenden" form (Fork) — mirrors OeffnenPayload but for WEAR_END. */
export interface PlugEndPayload {
  type: "WEAR_END";
  startTime: string;
  /** Der Träger hat die Zeit nicht angefasst: der Server datiert mit seiner Uhr, auf die Sekunde. */
  startIsNow?: boolean;
  deviceId: string;
  oeffnenGrund: string;
  note: string | null;
  /** Only set when user confirmed the Reinigung-limit-bypass sheet. */
  forcedCleaning?: boolean;
  /** True when user reports an erection occurred during REINIGUNG or TOILETTE removal. */
  erektionGemeldet?: boolean;
}

/** Bundled user-cleaning config (kept together to avoid prop sprawl). Enthält bewusst KEIN
 *  `erlaubt`-Flag mehr: ob gereinigt werden darf, beantwortet `cleaningBlock` vollständig — samt
 *  Grund. Zwei Quellen für dieselbe Frage waren der Ursprung dieser ganzen Fehlerfamilie. */
export interface CleaningConfig {
  maxMinutes: number;
  maxPerDay: number;
  usedToday: number;
  /** Serverseitig gefälltes Urteil (eine Uhr, Sub-Zeitzone): darf JETZT gereinigt werden, und wenn
   *  nein — warum nicht? `null` = erlaubt. Kommt aus `cleaningBlockReason()`, derselben Regel, die
   *  serverseitig über den Sperrzeit-Bruch entscheidet. Fehlt die Prop (Admin-Formular, Edit-Seite),
   *  gilt „nicht blockieren": dort ist der Grund nie REINIGUNG bzw. wird nichts neu geöffnet. */
  cleaningBlock?: CleaningBlockReason | null;
  /** Das nächste beginnende Reinigungsfenster — rein informativ, samt dem Tag, an dem es liegt. */
  nextWindow?: NextCleaningWindow | null;
  /** Fenster sind konfiguriert, binden aber gerade nicht, weil keine Sperrzeit läuft. Der Sub soll
   *  das lesen, statt sich zu wundern, warum er ausserhalb seiner Fenster folgenlos reinigen kann. */
  windowsInactive?: boolean;
  /** Nur der Plug-Pfad (Fork): dort gibt es kein `cleaningBlock`-Sammelurteil vom Server, deshalb
   *  kommt die Reinigungs-Freigabe hier direkt. Der KG-Pfad lässt das Feld weg. */
  erlaubt?: boolean;
}

/** Bundled Toilette config (Fork; like CleaningConfig but without windows). */
export interface ToiletteConfig {
  erlaubt: boolean;
  maxMinutes: number;
  maxPerDay: number;
  usedToday: number;
}

/** Bundled Sperrzeit state (user-dashboard only — admin skips these warnings). Das Sperr-Flag
 *  `cleaningAllowed` steckt in `CleaningConfig.cleaningBlock`, wo es mit dem User-Flag und dem
 *  Zeitfenster zu EINEM Urteil verrechnet ist. Die Toiletten-Freigabe (Fork) hat kein solches
 *  Sammel-Urteil und bleibt deshalb hier. */
export interface LockPeriodState {
  endsAt: string | null;
  indefinite: boolean;
  /** Ob DIESE Sperrzeit Toilettenöffnungen erlaubt — dann ist ein TOILETTE-Öffnen keine Sperrverletzung. */
  toiletteErlaubt: boolean;
  /** Nur der Plug-Pfad (Fork): dort gibt es kein Server-Sammelurteil wie `cleaningBlock`, deshalb
   *  wird die Reinigungs-Freigabe der Sperrzeit hier direkt mitgegeben. Der KG-Pfad lässt das Feld
   *  weg und entscheidet über `CleaningConfig.cleaningBlock`. */
  cleaningAllowed?: boolean;
}
