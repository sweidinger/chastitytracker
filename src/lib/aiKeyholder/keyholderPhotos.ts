import { prisma } from "@/lib/prisma";
import { loadUploadImage } from "@/lib/imageLoad";
import { formatDateTime } from "@/lib/utils";
import type { LlmPart, LlmMessage } from "./llmClient";

/**
 * Fotos für die AI-Keyholderin — sie SIEHT die Bilder wirklich (Vision), statt nur `hasImage: true`
 * zu lesen. Gesammelt werden die Bilder, die gerade eine Beurteilung verlangen bzw. frisch sind:
 * offene Straf-Erledigungs-Nachweise zuerst, dann die neuesten Foto-Einträge (Verschluss, Prüfung,
 * Orgasmus, Wear, Session).
 *
 * Zwei bewusste Grenzen: es wandern nur wenige, klein skalierte Bilder mit (Tokens/Latenz — bei jeder
 * Nachricht erneut), und alte Fotos bleiben draußen (sie sind längst beurteilt).
 */

/** Höchstens so viele Bilder pro Anfrage. */
const MAX_IMAGES = 3;
/** Nur Einträge aus diesem Zeitfenster. */
const MAX_AGE_H = 72;
/** Längste Kante — klein genug für zügige Antworten, groß genug zum Erkennen. */
const MAX_PX = 768;
const QUALITY = 75;

const TYPE_LABEL: Record<string, string> = {
  VERSCHLUSS: "Verschluss",
  OEFFNEN: "Öffnen",
  PRUEFUNG: "Kontrolle",
  ORGASMUS: "Orgasmus",
  WEAR_BEGIN: "Tragen (Start)",
  WEAR_END: "Tragen (Ende)",
  SESSION_BEGIN: "Session (Start)",
  SESSION_END: "Session (Ende)",
  PAUSE_BEGIN: "Pause (Start)",
  PAUSE_END: "Pause (Ende)",
};

export interface KeyholderPhoto {
  /** Kurze Beschriftung, die der AI sagt, was sie da sieht. */
  label: string;
  imageUrl: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  base64: string;
}

/** Sammelt die aktuell relevanten Fotos des Subs (Nachweise zuerst, dann neueste Einträge). */
export async function collectKeyholderPhotos(userId: string): Promise<KeyholderPhoto[]> {
  const since = new Date(Date.now() - MAX_AGE_H * 60 * 60 * 1000);

  const [proofs, entries] = await Promise.all([
    // Gemeldete Straf-Erledigungen mit Nachweis — die verlangen eine Entscheidung (kein Zeitlimit).
    prisma.strafeRecord.findMany({
      where: { userId, status: "PUNISHED", erledigtAt: null, gemeldetAt: { not: null }, nachweisUrl: { not: null } },
      orderBy: { gemeldetAt: "desc" },
      take: MAX_IMAGES,
      select: { refId: true, reason: true, notiz: true, gemeldetAt: true, nachweisUrl: true, erledigungNotiz: true },
    }),
    prisma.entry.findMany({
      where: { userId, imageUrl: { not: null }, startTime: { gte: since } },
      orderBy: { startTime: "desc" },
      take: MAX_IMAGES,
      select: { type: true, startTime: true, imageUrl: true, note: true, orgasmusArt: true },
    }),
  ]);

  const candidates: { label: string; imageUrl: string }[] = [
    ...proofs.map((p) => ({
      label:
        `Straf-Nachweis (refId=${p.refId}) — Strafe: ${p.reason ?? p.notiz ?? "?"}; ` +
        `gemeldet am ${formatDateTime(p.gemeldetAt as Date)}` +
        (p.erledigungNotiz ? `; Notiz des Subs: „${p.erledigungNotiz}"` : "; ohne Notiz"),
      imageUrl: p.nachweisUrl as string,
    })),
    ...entries.map((e) => ({
      label:
        `${TYPE_LABEL[e.type] ?? e.type} am ${formatDateTime(e.startTime)}` +
        (e.orgasmusArt ? ` (${e.orgasmusArt})` : "") +
        (e.note ? ` — Notiz: „${e.note}"` : ""),
      imageUrl: e.imageUrl as string,
    })),
  ].slice(0, MAX_IMAGES);

  const loaded = await Promise.all(
    candidates.map(async (c) => {
      const img = await loadUploadImage(c.imageUrl, { maxPx: MAX_PX, quality: QUALITY });
      return img ? { label: c.label, imageUrl: c.imageUrl, mediaType: img.mediaType, base64: img.base64 } : null;
    }),
  );
  return loaded.filter((p): p is KeyholderPhoto => p !== null);
}

/** Prompt-Abschnitt: erklärt der AI, dass die Bilder wirklich mitkommen und wozu. */
export function photoPromptSection(photos: KeyholderPhoto[]): string {
  if (photos.length === 0) return "";
  return [
    "",
    "--- Angehängte Fotos (du SIEHST sie) ---",
    "Die folgenden Bilder sind dieser Nachricht beigefügt, in dieser Reihenfolge:",
    ...photos.map((p, i) => `[Bild ${i + 1}] ${p.label}`),
    "Beurteile sie selbst: Ist der Nachweis plausibel? Passt er zu dem, was der Sub behauptet?",
    "Ein Straf-Nachweis prüfst du mit review_strafe (bestaetigen/ablehnen) — begründe die Ablehnung mit dem, was du im Bild siehst.",
    "Bilder älter als 72 h oder bereits beurteilte Nachweise werden NICHT angehängt — bewerte nur, was hier liegt.",
  ].join("\n");
}

/**
 * Hängt die Bilder an die LETZTE User-Nachricht an (Anthropic verlangt abwechselnde Rollen, eine
 * eigene Bild-Nachricht wäre also nicht erlaubt). Ohne Bilder bleibt alles unverändert.
 */
export function attachPhotos(messages: LlmMessage[], photos: KeyholderPhoto[]): LlmMessage[] {
  if (photos.length === 0) return messages;
  const lastUser = messages.map((m) => m.role).lastIndexOf("user");
  if (lastUser === -1) return messages;

  const imageParts: LlmPart[] = photos.map((p) => ({ type: "image", mediaType: p.mediaType, base64: p.base64 }));
  const existing = messages[lastUser].content;
  const textParts: LlmPart[] = typeof existing === "string" ? [{ type: "text", text: existing }] : existing;

  const next = [...messages];
  // Bilder VOR den Text — Modelle beziehen sich zuverlässiger auf vorangestellte Bilder.
  next[lastUser] = { role: "user", content: [...imageParts, ...textParts] };
  return next;
}
