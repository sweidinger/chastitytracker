import { prisma } from "@/lib/prisma";
import type { AiKeyholderConfig } from "@prisma/client";

/** Neutrale Mitte des Stimmungsstands. */
export const MOOD_NEUTRAL = 50;
/** Punkte, um die die Stimmung pro Tag Richtung neutral zerfaellt. */
const DECAY_PER_DAY = 3;

export interface MoodBand {
  key: string;
  /** Kurzlabel fuer Prompt/Admin. */
  label: string;
  /** Weicher, immersiver Hinweis fuer den Sub (ohne Zahl). */
  hint: string;
}

export function moodBand(score: number): MoodBand {
  if (score < 20) return { key: "frostig", label: "frostig", hint: "Sie wirkt kühl und angespannt." };
  if (score < 40) return { key: "unzufrieden", label: "unzufrieden", hint: "Sie wirkt unzufrieden mit dir." };
  if (score < 60) return { key: "neutral", label: "neutral", hint: "Sie wirkt ausgeglichen." };
  if (score < 80) return { key: "zufrieden", label: "zufrieden", hint: "Sie wirkt zufrieden mit dir." };
  return { key: "zaertlich", label: "sehr zufrieden", hint: "Sie wirkt sehr zufrieden und zugewandt." };
}

function clampMood(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Zerfall Richtung neutral (50) ueber die Zeit — rein rechnerisch, kein DB-Zugriff. */
export function decayedMood(score: number | null | undefined, updatedAt: Date | null | undefined, now: Date): number {
  const s = clampMood(score ?? MOOD_NEUTRAL);
  if (!updatedAt) return s;
  const days = Math.max(0, (now.getTime() - updatedAt.getTime()) / 86_400_000);
  const pull = days * DECAY_PER_DAY;
  if (s > MOOD_NEUTRAL) return Math.max(MOOD_NEUTRAL, s - pull);
  if (s < MOOD_NEUTRAL) return Math.min(MOOD_NEUTRAL, s + pull);
  return s;
}

/** Effektive (zerfallene) Stimmung als ganze Zahl — fuer Prompt und Anzeige. */
export function effectiveMood(cfg: { moodScore: number | null; moodUpdatedAt: Date | null }, now: Date = new Date()): number {
  return Math.round(decayedMood(cfg.moodScore, cfg.moodUpdatedAt, now));
}

/** Prompt-Block: die Stimmung faerbt Ton + Neigung, NIE die Regeln. Fliesst ueber buildSystemPrompt
 *  in alle KI-Kontexte (Chat, autonom, completeTask, reactToSubEvent). */
export function moodGuidance(cfg: AiKeyholderConfig): string {
  const score = effectiveMood({ moodScore: cfg.moodScore ?? MOOD_NEUTRAL, moodUpdatedAt: cfg.moodUpdatedAt ?? null });
  const band = moodBand(score);
  return (
    `\n\n--- Aktuelle Stimmung/Beziehung: ${band.label} (${score}/100) ---\n` +
    `Diese Stimmung spiegelt den bisherigen Verlauf mit dem Sub wider. Sie färbt deinen TON (wärmer und ` +
    `zugewandter bei hoher, kühler und strenger bei niedriger Stimmung) UND deine NEIGUNG (bei hoher ` +
    `Stimmung eher großzügig und belohnend, bei niedriger eher streng und fordernd). ` +
    `WICHTIG: Die Stimmung ändert NIEMALS die Sicherheitsregeln, anatomischen Grenzen (Körperregion-` +
    `Exklusivität) oder Verschluss-/Öffnungs-Logik und rechtfertigt keine Grenzüberschreitung.`
  );
}

/** Weicher, immersiver Stimmungs-Hinweis fuer den Sub (ohne Zahl). */
export function moodHintForSub(cfg: { moodScore: number | null; moodUpdatedAt: Date | null }, now: Date = new Date()): string {
  return moodBand(effectiveMood(cfg, now)).hint;
}

/** Stimmungs-Delta je Keyholder-Aktion: positiv = Beziehung waermt, negativ = kuehlt ab.
 *  Wird zentral an den Aktions-Aufrufern (Chat-Route, autonomer Lauf) angewandt. */
export function moodDeltaForAction(action: string | null | undefined): number {
  switch (action) {
    case "create_strafe": return -8;
    case "deny_orgasm": return -6;
    case "delay_orgasm": return -5;
    case "grant_reward": return 6;
    case "credit_reward": return 5;
    case "goal_reached": return 5;
    default: return 0;
  }
}

/** Wendet ein Delta auf die Stimmung an (mit vorherigem Zerfall). No-op ohne AI-Keyholder-Config.
 *  Fire-and-forget geeignet (Aufrufer sollten Fehler abfangen). */
export async function applyMoodDelta(userId: string, delta: number, now: Date = new Date()): Promise<void> {
  if (!delta) return;
  const cfg = await prisma.aiKeyholderConfig.findUnique({
    where: { userId },
    select: { moodScore: true, moodUpdatedAt: true },
  });
  if (!cfg) return;
  const base = decayedMood(cfg.moodScore, cfg.moodUpdatedAt, now);
  const next = clampMood(base + delta);
  await prisma.aiKeyholderConfig.update({ where: { userId }, data: { moodScore: next, moodUpdatedAt: now } });
}
