/**
 * Pause-Service: Logik für PAUSE_BEGIN / PAUSE_END Einträge.
 *
 * Geräte-Mapping:
 *   CAGE → reinigung* / toilette* User-Felder (als kombiniertes Pause-Budget)
 *   PLUG → plugReinigung* / plugToilette* User-Felder
 *
 * Regeln:
 *   - Max. 1 aktive Pause pro Gerät gleichzeitig
 *   - Cage und Plug können gleichzeitig pausiert sein
 *   - PAUSE_END Foto ist Pflicht (wird in der API-Route geprüft)
 *   - Bei Überschreitung maxMinuten → im Strafbuch erkannt (keine Auto-Bestrafung)
 */

import { prisma } from "@/lib/prisma";
import type { PrismaTx } from "@/lib/queries";
import { getMidnightToday } from "@/lib/utils";
import { APP_TZ } from "@/lib/utils";

export type PauseDevice = "CAGE" | "PLUG";

/** User-Felder die für Pause-Limits relevant sind. */
export interface PauseSettings {
  erlaubt: boolean;
  maxMinuten: number;
  maxProTag: number;
}

/** Liest Pause-Einstellungen für das gewünschte Gerät aus den User-Feldern. */
export function pauseSettingsForDevice(
  user: {
    reinigungErlaubt: boolean; reinigungMaxMinuten: number; reinigungMaxProTag: number;
    toiletteErlaubt: boolean; toiletteMaxMinuten: number; toiletteMaxProTag: number;
    plugReinigungErlaubt: boolean; plugReinigungMaxMinuten: number; plugReinigungMaxProTag: number;
    plugToiletteMaxMinuten: number;
  },
  device: PauseDevice,
): PauseSettings {
  if (device === "CAGE") {
    // Pause erlaubt wenn mindestens eine der beiden Öffnungsarten erlaubt ist
    const erlaubt = user.reinigungErlaubt || user.toiletteErlaubt;
    // Maximale Pausendauer = größere der beiden Limits (0 = kein Limit gesetzt → Standard 15 Min)
    const maxMinuten = Math.max(
      user.reinigungErlaubt ? user.reinigungMaxMinuten : 0,
      user.toiletteErlaubt ? user.toiletteMaxMinuten : 0,
    ) || 15;
    // Max pro Tag = Summe beider Budgets
    const maxProTag = (user.reinigungErlaubt ? user.reinigungMaxProTag : 0)
      + (user.toiletteErlaubt ? user.toiletteMaxProTag : 0);
    return { erlaubt, maxMinuten, maxProTag };
  } else {
    // Plug-Toilette ist immer erlaubt & unbegrenzt → Plug-Pause immer erlaubt, kein Tageslimit.
    const erlaubt = true;
    const maxMinuten = Math.max(
      user.plugReinigungErlaubt ? user.plugReinigungMaxMinuten : 0,
      user.plugToiletteMaxMinuten,
    ) || 15;
    const maxProTag = 0; // unbegrenzt
    return { erlaubt, maxMinuten, maxProTag };
  }
}

/** Pause-Grund (Reinigung/Toilette) mit den konfigurierten Limits für das jeweilige Gerät. */
export interface PauseReasonOption {
  grund: "REINIGUNG" | "TOILETTE";
  /** Max. Dauer dieser Pause in Minuten (aus den Einstellungen). */
  maxMinuten: number;
  /** Max. Anzahl pro Tag; 0 = unbegrenzt. */
  maxProTag: number;
}

/** User-Felder für die Pause-Grund-Ableitung (Reinigung/Toilette, KG + Plug). */
export interface PauseReasonUserFields {
  reinigungErlaubt: boolean; reinigungMaxMinuten: number; reinigungMaxProTag: number;
  toiletteErlaubt: boolean; toiletteMaxMinuten: number; toiletteMaxProTag: number;
  plugReinigungErlaubt: boolean; plugReinigungMaxMinuten: number; plugReinigungMaxProTag: number;
  plugToiletteMaxMinuten: number;
}

/** Liefert die für ein Gerät erlaubten Pause-Gründe inkl. Limits.
 *  KG: Reinigung/Toilette je nach *Erlaubt*-Flag. Plug: Reinigung wenn aktiviert,
 *  Toilette IMMER (unbegrenzt) — analog zur Öffnungs-Logik. */
export function pauseReasonsForDevice(user: PauseReasonUserFields, device: PauseDevice): PauseReasonOption[] {
  const out: PauseReasonOption[] = [];
  if (device === "CAGE") {
    if (user.reinigungErlaubt) out.push({ grund: "REINIGUNG", maxMinuten: user.reinigungMaxMinuten, maxProTag: user.reinigungMaxProTag });
    if (user.toiletteErlaubt) out.push({ grund: "TOILETTE", maxMinuten: user.toiletteMaxMinuten, maxProTag: user.toiletteMaxProTag });
  } else {
    if (user.plugReinigungErlaubt) out.push({ grund: "REINIGUNG", maxMinuten: user.plugReinigungMaxMinuten, maxProTag: user.plugReinigungMaxProTag });
    // Plug-Toilette ist immer erlaubt & unbegrenzt
    out.push({ grund: "TOILETTE", maxMinuten: user.plugToiletteMaxMinuten, maxProTag: 0 });
  }
  return out;
}

/** Grund einer Cage-Pause (die beiden zählbaren Öffnungsarten). */
export type PauseGrund = "REINIGUNG" | "TOILETTE";

/** Rest-Kontingent einer Pausen-Art für den heutigen Kalendertag. */
export interface PauseQuotaEntry {
  grund: PauseGrund;
  /** Heute bereits genutzte Pausen dieser Art (PAUSE_BEGIN seit Mitternacht). */
  used: number;
  /** Tageslimit; 0 = unbegrenzt. */
  max: number;
  /** Verbleibende Pausen, oder null bei unbegrenztem Limit (max = 0). Nie negativ. */
  remaining: number | null;
}

/** Nur die CAGE-relevanten Reinigungs-/Toiletten-Felder (Teilmenge von {@link PauseReasonUserFields}). */
export interface CagePauseUserFields {
  reinigungErlaubt: boolean; reinigungMaxMinuten: number; reinigungMaxProTag: number;
  toiletteErlaubt: boolean; toiletteMaxMinuten: number; toiletteMaxProTag: number;
}

/**
 * Heutige PAUSE_BEGIN-Anzahl je Grund (REINIGUNG/TOILETTE) für ein Gerät. Spiegelt EXAKT die
 * Tageslimit-Durchsetzung in `api/entries` (dieselben where-Bedingungen: type=PAUSE_BEGIN,
 * pauseDevice, oeffnenGrund, startTime ab lokaler Mitternacht), damit die Rest-Anzeige nie von der
 * tatsächlich durchgesetzten Grenze abweicht.
 */
export async function pauseBeginCountsToday(
  userId: string,
  device: PauseDevice,
  now: Date,
  tz: string = APP_TZ,
): Promise<Record<PauseGrund, number>> {
  const midnight = getMidnightToday(now, tz);
  const rows = await prisma.entry.groupBy({
    by: ["oeffnenGrund"],
    where: {
      userId,
      type: "PAUSE_BEGIN",
      pauseDevice: device,
      oeffnenGrund: { in: ["REINIGUNG", "TOILETTE"] },
      startTime: { gte: midnight },
    },
    _count: { _all: true },
  });
  const out: Record<PauseGrund, number> = { REINIGUNG: 0, TOILETTE: 0 };
  for (const r of rows) {
    if (r.oeffnenGrund === "REINIGUNG" || r.oeffnenGrund === "TOILETTE") out[r.oeffnenGrund] = r._count._all;
  }
  return out;
}

/**
 * Baut die Rest-Kontingent-Liste der Cage-Pausen für die laufende Session. Nutzt
 * {@link pauseReasonsForDevice} als einzige Quelle dafür, WELCHE Arten erlaubt sind (deaktivierte
 * fehlen), und kombiniert sie mit den heute genutzten Zählern. `max = 0` bleibt als „unbegrenzt"
 * erhalten (remaining = null); begrenzte Arten liefern nie-negatives `remaining`.
 */
export function buildCagePauseQuota(
  user: CagePauseUserFields,
  counts: Record<PauseGrund, number>,
): PauseQuotaEntry[] {
  // Plug-Felder für die CAGE-Ableitung irrelevant → mit neutralen Defaults auffüllen (an EINER Stelle).
  const reasons = pauseReasonsForDevice(
    { ...user, plugReinigungErlaubt: false, plugReinigungMaxMinuten: 0, plugReinigungMaxProTag: 0, plugToiletteMaxMinuten: 0 },
    "CAGE",
  );
  return reasons.map((r) => {
    const used = counts[r.grund] ?? 0;
    return {
      grund: r.grund,
      used,
      max: r.maxProTag,
      remaining: r.maxProTag > 0 ? Math.max(0, r.maxProTag - used) : null,
    };
  });
}

/** Aktiver Pause-Eintrag (PAUSE_BEGIN ohne passendes PAUSE_END), oder null. */
export async function getActivePause(
  userId: string,
  device: PauseDevice,
  tx?: PrismaTx,
): Promise<{ id: string; startTime: Date } | null> {
  const db = tx ?? prisma;
  // Find PAUSE_BEGIN entries for this device, get the latest
  const begins = await (db as typeof prisma).entry.findMany({
    where: { userId, type: "PAUSE_BEGIN", pauseDevice: device },
    orderBy: { startTime: "desc" },
    take: 50,
    select: { id: true, startTime: true },
  });
  const ends = await (db as typeof prisma).entry.findMany({
    where: { userId, type: "PAUSE_END", pauseDevice: device },
    orderBy: { startTime: "desc" },
    take: 50,
    select: { id: true, startTime: true },
  });

  if (begins.length === 0) return null;

  const latest = begins[0];
  // Active if there's no PAUSE_END after the latest PAUSE_BEGIN
  const latestEnd = ends[0];
  if (!latestEnd || latestEnd.startTime <= latest.startTime) {
    return latest;
  }
  return null;
}

/** Zählt abgeschlossene Pausen heute (für Counter "X von Y heute"). */
export async function getPauseCountToday(
  userId: string,
  device: PauseDevice,
  now: Date,
  tz: string = APP_TZ,
): Promise<number> {
  const midnight = getMidnightToday(now, tz);
  return prisma.entry.count({
    where: {
      userId,
      type: "PAUSE_END",
      pauseDevice: device,
      startTime: { gte: midnight },
    },
  });
}

/** Summiert alle Pause-Dauern (ms) heute. Verwendet abgeschlossene Paare. */
export async function getPausedMsToday(
  userId: string,
  device: PauseDevice,
  now: Date,
  tz: string = APP_TZ,
): Promise<number> {
  const midnight = getMidnightToday(now, tz);
  // Fetch both begin and end entries since midnight
  const entries = await prisma.entry.findMany({
    where: {
      userId,
      type: { in: ["PAUSE_BEGIN", "PAUSE_END"] },
      pauseDevice: device,
      startTime: { gte: midnight },
    },
    orderBy: { startTime: "asc" },
    select: { type: true, startTime: true },
  });

  let totalMs = 0;
  let openBegin: Date | null = null;
  for (const e of entries) {
    if (e.type === "PAUSE_BEGIN") {
      openBegin = e.startTime;
    } else if (e.type === "PAUSE_END" && openBegin) {
      totalMs += e.startTime.getTime() - openBegin.getTime();
      openBegin = null;
    }
  }
  // Add currently open pause if any
  if (openBegin) {
    totalMs += now.getTime() - openBegin.getTime();
  }
  return totalMs;
}

/** Berechnet Pause-Ms die vom Tragezeit-Timer abgezogen werden müssen (für eine Wear-Session). */
export function pauseMsInRange(
  pauseEntries: { type: string; startTime: Date; pauseDevice: string | null }[],
  device: PauseDevice,
  sessionStart: Date,
  sessionEnd: Date,
): number {
  const relevant = pauseEntries
    .filter((e) => e.pauseDevice === device && (e.type === "PAUSE_BEGIN" || e.type === "PAUSE_END"))
    .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

  let total = 0;
  let openBegin: Date | null = null;

  for (const e of relevant) {
    if (e.type === "PAUSE_BEGIN") {
      // Clamp to session range
      const begin = e.startTime < sessionStart ? sessionStart : e.startTime;
      if (begin < sessionEnd) openBegin = begin;
    } else if (e.type === "PAUSE_END" && openBegin) {
      const end = e.startTime > sessionEnd ? sessionEnd : e.startTime;
      if (end > openBegin) total += end.getTime() - openBegin.getTime();
      openBegin = null;
    }
  }
  // Open pause extends to sessionEnd
  if (openBegin && openBegin < sessionEnd) {
    total += sessionEnd.getTime() - openBegin.getTime();
  }
  return total;
}

// Pause-Überzug wird nicht mehr automatisch bestraft (kein StrafeRecord beim PAUSE_END).
// Die Erkennung passiert live in buildStrafbuch (Pause-Paare vs. konfigurierte Maximaldauer);
// das Urteil fällt die Keyholderin (AI) oder der Admin.
