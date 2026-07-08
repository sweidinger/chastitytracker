import { prisma } from "@/lib/prisma";
import type { ServiceResult } from "@/lib/serviceResult";
import { clamp } from "@/lib/utils";

export interface SetToiletteParams {
  /** Allow toilet pauses. */
  erlaubt?: boolean;
  /** Max minutes per toilet pause. */
  maxMinuten?: number;
  /** Max toilet pauses per day (0 = unlimited). */
  maxProTag?: number;
}

/** Stabile MCP-Sicht der Toiletten-Regeln. Analog zu ReinigungView (ohne Zeitfenster, da Toilette nie zeitgebunden). */
export interface ToiletteView {
  allowed: boolean;
  maxMinutesPerBreak: number;
  maxPausesPerDay: number | null;
  /** Toiletten-Öffnungen bereits heute genutzt (zählt OEFFNEN[TOILETTE] im Kalendertag). */
  usedToday: number;
  /** Immer false — Toilette hat keine Zeitfenster (jederzeit erlaubt wenn allowed=true). */
  timeBound: false;
}

/** User-Toilette-Spalten für Prisma-Select. */
export interface ToiletteUserFields {
  toiletteErlaubt: boolean | null;
  toiletteMaxMinuten: number | null;
  toiletteMaxProTag: number | null;
}

/** Baut die ToiletteView aus den User-Feldern + heute verbrauchten Öffnungen. */
export function buildToiletteView(user: ToiletteUserFields, usedToday: number): ToiletteView {
  const maxProTag = user.toiletteMaxProTag ?? 0;
  return {
    allowed: user.toiletteErlaubt ?? false,
    maxMinutesPerBreak: user.toiletteMaxMinuten ?? 15,
    maxPausesPerDay: maxProTag > 0 ? maxProTag : null,
    usedToday,
    timeBound: false,
  };
}

/** Bundled ToiletteConfig für OeffnenFormCore. */
export interface ToiletteConfig {
  erlaubt: boolean;
  maxMinuten: number;
  maxProTag: number;
  heuteAnzahl: number;
}

/** Heute bereits verbrauchte Toiletten-Öffnungen (CH-Kalendertag). */
import { midnightInTZ, APP_TZ } from "@/lib/utils";

export async function toiletteVerbrauchtHeute(userId: string, now: Date, tz = APP_TZ): Promise<number> {
  return prisma.entry.count({
    where: { userId, type: "OEFFNEN", oeffnenGrund: "TOILETTE", startTime: { gte: midnightInTZ(now, tz) } },
  });
}

/** Max minutes clamped to valid range. */
const MAX_MINUTEN_RANGE = { min: 1, max: 120, fallback: 15 } as const;
/** Max pauses per day clamped (0 = unlimited). */
const MAX_PRO_TAG_RANGE = { min: 0, max: 20, fallback: 0 } as const;

/**
 * Updates a user's toilet-pause (Toilette) settings.
 * Shared by PATCH /api/admin/users/[id] and the MCP tool.
 */
export async function setToiletteSettings(userId: string, params: SetToiletteParams): Promise<ServiceResult<null>> {
  const data: {
    toiletteErlaubt?: boolean; toiletteMaxMinuten?: number; toiletteMaxProTag?: number;
  } = {};

  if (params.erlaubt !== undefined) data.toiletteErlaubt = params.erlaubt;
  if (params.maxMinuten !== undefined) data.toiletteMaxMinuten = clamp(params.maxMinuten, MAX_MINUTEN_RANGE);
  if (params.maxProTag !== undefined) data.toiletteMaxProTag = clamp(params.maxProTag, MAX_PRO_TAG_RANGE);

  if (Object.keys(data).length === 0) return { ok: false, status: 400, error: "Keine Felder zum Aktualisieren" };

  await prisma.user.update({ where: { id: userId }, data });
  return { ok: true, data: null };
}
