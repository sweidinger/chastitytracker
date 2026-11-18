import { prisma } from "@/lib/prisma";

/**
 * Belohnungs-/Straf-Historie: führt den Belohnungs-Kontoauszug (BelohnungEvent) und die geurteilten
 * Vergehen (StrafeRecord) zu EINER Zeitleiste zusammen — plus Kennzahlen und dem Guthaben-Verlauf
 * für den Graphen. Rein lesend; geschrieben wird an den jeweiligen Buchungsstellen (siehe belohnung.ts).
 */

export type HistorieKind = "belohnung" | "strafe";

export interface HistorieItem {
  id: string;
  at: Date;
  kind: HistorieKind;
  /** BelohnungEvent.type (VERDIENT | GEWAEHRT | …) bzw. StrafeRecord.status (PUNISHED | DISMISSED). */
  type: string;
  delta: number;              // Guthaben-Änderung (nur bei kind="belohnung" relevant)
  balanceAfter: number | null; // Kontostand nach dem Ereignis (nur Belohnung)
  text: string | null;        // Detail bzw. Straf-Text
  erledigt: boolean | null;   // nur Strafen: erledigtAt gesetzt?
}

export interface HistorieSummary {
  verdient: number;
  gewaehrt: number;
  eingeloest: number;
  verfallen: number;
  entzogen: number;
  verschoben: number;
  strafen: number;    // PUNISHED
  verworfen: number;  // DISMISSED
  offeneStrafen: number;
}

export interface HistorieMonat {
  key: string;        // YYYY-MM
  belohnungen: number; // VERDIENT + EINGELOEST (Positives)
  strafen: number;     // PUNISHED + ENTZOGEN (Negatives)
}

export interface HistorieData {
  items: HistorieItem[];
  balance: number;
  /** Guthaben-Verlauf (chronologisch) für den Sparkline-Graphen. */
  series: { at: Date; balance: number }[];
  summary: HistorieSummary;
  monthly: HistorieMonat[]; // letzte 6 Monate, chronologisch
}

const MONTH_COUNT = 6;

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Zusammengeführte Historie eines Subs (neueste zuerst in `items`). */
export async function getHistorie(userId: string, limit = 60): Promise<HistorieData> {
  const [events, strafen, user] = await Promise.all([
    prisma.belohnungEvent.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 200 }),
    prisma.strafeRecord.findMany({ where: { userId }, orderBy: { bestraftDatum: "desc" }, take: 200 }),
    prisma.user.findUnique({ where: { id: userId }, select: { verdienteOrgasmen: true } }),
  ]);

  const items: HistorieItem[] = [
    ...events.map((e): HistorieItem => ({
      id: e.id,
      at: e.createdAt,
      kind: "belohnung",
      type: e.type,
      delta: e.delta,
      balanceAfter: e.balanceAfter,
      text: e.detail,
      erledigt: null,
    })),
    ...strafen.map((s): HistorieItem => ({
      id: s.id,
      at: s.bestraftDatum,
      kind: "strafe",
      type: s.status,
      delta: 0,
      balanceAfter: null,
      text: s.reason ?? s.notiz,
      erledigt: s.status === "PUNISHED" ? s.erledigtAt != null : null,
    })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  const summary: HistorieSummary = {
    verdient: events.filter((e) => e.type === "VERDIENT").length,
    gewaehrt: events.filter((e) => e.type === "GEWAEHRT").length,
    eingeloest: events.filter((e) => e.type === "EINGELOEST").length,
    verfallen: events.filter((e) => e.type === "VERFALLEN").length,
    entzogen: events.filter((e) => e.type === "ENTZOGEN").length,
    verschoben: events.filter((e) => e.type === "VERSCHOBEN").length,
    strafen: strafen.filter((s) => s.status === "PUNISHED").length,
    verworfen: strafen.filter((s) => s.status === "DISMISSED").length,
    offeneStrafen: strafen.filter((s) => s.status === "PUNISHED" && s.erledigtAt == null).length,
  };

  // Guthaben-Verlauf: nur Ereignisse mit Kontostand, chronologisch (älteste zuerst).
  const series = [...events]
    .reverse()
    .map((e) => ({ at: e.createdAt, balance: e.balanceAfter }));

  // Letzte 6 Monate: Positives vs. Negatives.
  const now = new Date();
  const monthly: HistorieMonat[] = [];
  for (let i = MONTH_COUNT - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = monthKey(d);
    monthly.push({
      key,
      belohnungen: events.filter((e) => monthKey(e.createdAt) === key && (e.type === "VERDIENT" || e.type === "EINGELOEST")).length,
      strafen:
        events.filter((e) => monthKey(e.createdAt) === key && (e.type === "ENTZOGEN" || e.type === "VERSCHOBEN")).length +
        strafen.filter((s) => monthKey(s.bestraftDatum) === key && s.status === "PUNISHED").length,
    });
  }

  return {
    items: items.slice(0, limit),
    balance: user?.verdienteOrgasmen ?? 0,
    series,
    summary,
    monthly,
  };
}
