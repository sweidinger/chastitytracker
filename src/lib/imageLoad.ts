import { readFile } from "fs/promises";
import { join, basename } from "path";
import sharp from "sharp";
import { IMAGE_MEDIA_TYPES } from "@/lib/imageUtils";
import type { Rotation } from "@/lib/constants";

/**
 * Lädt ein hochgeladenes Bild als base64 — die gemeinsame Grundlage für alle Modell-Aufrufe mit
 * Bildern (Code-Verifikation, Siegel-/Geräte-Erkennung, AI-Keyholderin-Vision).
 *
 * Zwei Dinge macht die Funktion bewusst zentral: den Pfad-Schutz (nur Dateiname aus dem
 * uploads-Verzeichnis — kein Traversal) und das Herunterskalieren vor dem Versand (spart
 * Vision-Tokens und Latenz drastisch, besonders bei lokalen Modellen).
 */

export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export interface LoadedImage {
  base64: string;
  mediaType: ImageMediaType;
  bytes: number;
  filename: string;
}

export interface LoadImageOptions {
  /** Drehung im Uhrzeigersinn (0|90|180|270), wie im Formular angezeigt. */
  rotation?: Rotation;
  /** Längste Kante nach dem Skalieren. */
  maxPx: number;
  /** JPEG-Qualität nach dem Skalieren. */
  quality?: number;
}

/** Lädt `imageUrl` (interner Upload-Pfad) skaliert als base64. `null`, wenn die Datei fehlt oder
 *  der Pfad nicht in das uploads-Verzeichnis zeigt. */
export async function loadUploadImage(
  imageUrl: string,
  opts: LoadImageOptions,
): Promise<LoadedImage | null> {
  const filename = basename(imageUrl);
  if (!filename || filename.includes("..") || filename.includes("/")) return null;

  const fullPath = join(process.cwd(), "data", "uploads", filename);
  let raw: Buffer;
  try {
    raw = await readFile(fullPath);
  } catch {
    return null;
  }

  let buffer: Buffer;
  let mediaType: ImageMediaType;
  try {
    buffer = await sharp(raw)
      .rotate(opts.rotation || 0)
      .resize(opts.maxPx, opts.maxPx, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: opts.quality ?? 85 })
      .toBuffer();
    mediaType = "image/jpeg";
  } catch {
    // Fallback: Original ohne Skalierung (z.B. Format, das sharp nicht kennt).
    buffer = raw;
    const ext = filename.split(".").pop()?.toLowerCase() ?? "";
    mediaType = IMAGE_MEDIA_TYPES[ext] ?? "image/jpeg";
  }

  return { base64: buffer.toString("base64"), mediaType, bytes: buffer.length, filename };
}
