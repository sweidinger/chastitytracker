/**
 * Shared contracts for entry-form Cores (Orgasmus, Pruefung, Verschluss, Oeffnen).
 *
 * SubmitResult: what each `submitFn` callback returns:
 *   { ok: true }                   → Core calls onSuccess() (caller navigates).
 *   { ok: false, error: string }   → Core displays the error inline.
 *   { ok: true, offline: true }    → caller handled queuing, Core calls onSuccess().
 */

// `import type` — zur Laufzeit gelöscht, zieht also kein Prisma in das Client-Bundle.
import type { ReinigungsFenster } from "@/lib/reinigungService";
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
  verifikationStatus: "ai" | null;
  /** Clockwise rotation applied to the photo in the form (0|90|180|270).
   *  Server-side AI verify must use the same rotation as the client preview. */
  imageRotation: number;
}

export interface VerschlussPayload {
  type: "VERSCHLUSS";
  startTime: string;
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
}

export interface OeffnenPayload {
  type: "OEFFNEN";
  startTime: string;
  oeffnenGrund: string;
  note: string | null;
  /** Only set when user confirmed the Reinigung-limit-bypass sheet. */
  forcedReinigung?: boolean;
  /** True when user reports an erection occurred during REINIGUNG or TOILETTE opening. */
  erektionGemeldet?: boolean;
}

export interface WearBeginPayload {
  type: "WEAR_BEGIN";
  startTime: string;
  deviceId: string;
  imageUrl: string | null;
  imageExifTime: string | null;
  note: string | null;
}

export interface WearEndPayload {
  type: "WEAR_END";
  startTime: string;
  deviceId: string;
  imageUrl: string | null;
  imageExifTime: string | null;
  note: string | null;
}

/** Payload for the Plug "Tragen beenden" form — mirrors OeffnenPayload but for WEAR_END. */
export interface PlugEndPayload {
  type: "WEAR_END";
  startTime: string;
  deviceId: string;
  oeffnenGrund: string;
  note: string | null;
  /** Only set when user confirmed the Reinigung-limit-bypass sheet. */
  forcedReinigung?: boolean;
  /** True when user reports an erection occurred during REINIGUNG or TOILETTE removal. */
  erektionGemeldet?: boolean;
}

/** Bundled user-cleaning config (kept together to avoid prop sprawl). Enthaelt bewusst KEIN
 *  `erlaubt`-Flag mehr: ob gereinigt werden darf, beantwortet `cleaningBlock` vollstaendig — samt
 *  Grund. Zwei Quellen fuer dieselbe Frage waren der Ursprung dieser ganzen Fehlerfamilie. */
export interface ReinigungConfig {
  maxMinuten: number;
  maxProTag: number;
  heuteAnzahl: number;
  /** Serverseitig gefälltes Urteil (eine Uhr, Sub-Zeitzone): darf JETZT gereinigt werden, und wenn
   *  nein — warum nicht? `null` = erlaubt. Kommt aus `cleaningBlockReason()`, derselben Regel, die
   *  serverseitig über den Sperrzeit-Bruch entscheidet. Fehlt die Prop (Admin-Formular, Edit-Seite),
   *  gilt „nicht blockieren": dort ist der Grund nie REINIGUNG bzw. wird nichts neu geöffnet. */
  cleaningBlock?: CleaningBlockReason | null;
  /** Das nächste beginnende Reinigungsfenster — rein informativ. */
  nextWindow?: ReinigungsFenster | null;
  /** Nur der Plug-Pfad (Fork): dort gibt es kein `cleaningBlock`-Sammelurteil vom Server, deshalb
   *  kommt die Reinigungs-Freigabe hier direkt. Der KG-Pfad laesst das Feld weg. */
  erlaubt?: boolean;
}

/** Bundled Toilette config (like ReinigungConfig but without Fenster). */
export interface ToiletteConfig {
  erlaubt: boolean;
  maxMinuten: number;
  maxProTag: number;
  heuteAnzahl: number;
}

/** Bundled Sperrzeit state (user-dashboard only — admin skips these warnings). Das Sperr-Flag
 *  `reinigungErlaubt` steckt in `ReinigungConfig.cleaningBlock`, wo es mit dem User-Flag und dem
 *  Zeitfenster zu EINEM Urteil verrechnet ist. Die Toiletten-Freigabe (Fork) hat kein solches
 *  Sammel-Urteil und bleibt deshalb hier. */
export interface SperrzeitState {
  endetAt: string | null;
  unbefristet: boolean;
  /** Ob DIESE Sperrzeit Toilettenoeffnungen erlaubt — dann ist ein TOILETTE-Oeffnen keine Sperrverletzung. */
  toiletteErlaubt: boolean;
  /** Nur der Plug-Pfad (Fork): dort gibt es kein Server-Sammelurteil wie `cleaningBlock`, deshalb
   *  wird die Reinigungs-Freigabe der Sperrzeit hier direkt mitgegeben. Der KG-Pfad laesst das Feld
   *  weg und entscheidet ueber `ReinigungConfig.cleaningBlock`. */
  reinigungErlaubt?: boolean;
}
