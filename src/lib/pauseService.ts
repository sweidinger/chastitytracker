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
 *   - Bei Überschreitung maxMinuten → StrafeRecord(PAUSE_OVERAGE) auto-erstellt
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

/** Auto-creates StrafeRecord(PAUSE_OVERAGE) when a PAUSE_END exceeds maxMinuten.
 *  Returns true if a Strafe was created. */
export async function maybeCreatePauseOverageStrafe(
  tx: PrismaTx,
  userId: string,
  pauseEndEntryId: string,
  pauseBeginTime: Date,
  pauseEndTime: Date,
  maxMinuten: number,
): Promise<boolean> {
  const durationMs = pauseEndTime.getTime() - pauseBeginTime.getTime();
  const durationMin = durationMs / 60_000;

  if (durationMin <= maxMinuten) return false;

  await (tx as typeof prisma).strafeRecord.create({
    data: {
      userId,
      offenseType: "PAUSE_OVERAGE",
      refId: pauseEndEntryId,
      bestraftDatum: pauseEndTime,
      status: "PUNISHED",
      judgedBy: "system",
      reason: `Pause ${Math.round(durationMin)} Min (erlaubt: ${maxMinuten} Min)`,
    },
  });
  return true;
}
