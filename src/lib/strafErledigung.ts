import { prisma } from "@/lib/prisma";
import type { ServiceResult } from "@/lib/serviceResult";
import { notifyUser } from "@/lib/notify";
import { getControllersOfUser } from "@/lib/keyholder";
import { isValidImageUrl } from "@/lib/constants";

/**
 * Strafen-Erledigung — schließt den Loop einer verhängten Strafe.
 *
 * Ablauf: offen → der Sub meldet die Erledigung (optional mit Nachweis-Foto und Notiz) → „gemeldet"
 * (wartet auf Prüfung) → die Keyholderin (oder die AI) bestätigt (erledigtAt gesetzt) oder lehnt mit
 * Begründung ab (gemeldetAt geleert, Strafe wieder offen). Der Sub kann nach einer Ablehnung erneut melden.
 */

/** Status einer verhängten Strafe aus Sicht der Erledigung. */
export type StrafStatus = "offen" | "gemeldet" | "erledigt";

export interface StrafeFuerSub {
  id: string;
  refId: string;
  status: StrafStatus;
  strafe: string | null;       // Urteilstext (StrafeRecord.reason)
  verhaengtAm: Date;
  gemeldetAt: Date | null;
  erledigtAt: Date | null;
  nachweisUrl: string | null;
  erledigungNotiz: string | null;
  ablehnungGrund: string | null; // letzte Ablehnung (bleibt als Hinweis stehen)
}

export function strafStatus(r: { erledigtAt: Date | null; gemeldetAt: Date | null }): StrafStatus {
  if (r.erledigtAt) return "erledigt";
  if (r.gemeldetAt) return "gemeldet";
  return "offen";
}

/** Alle verhängten Strafen eines Subs (offene zuerst, dann gemeldete, dann erledigte). */
export async function getStrafenForSub(userId: string): Promise<StrafeFuerSub[]> {
  const rows = await prisma.strafeRecord.findMany({
    where: { userId, status: "PUNISHED" },
    orderBy: { bestraftDatum: "desc" },
    take: 100,
  });
  const rank: Record<StrafStatus, number> = { offen: 0, gemeldet: 1, erledigt: 2 };
  return rows
    .map((r): StrafeFuerSub => ({
      id: r.id,
      refId: r.refId,
      status: strafStatus(r),
      strafe: r.reason,
      verhaengtAm: r.bestraftDatum,
      gemeldetAt: r.gemeldetAt,
      erledigtAt: r.erledigtAt,
      nachweisUrl: r.nachweisUrl,
      erledigungNotiz: r.erledigungNotiz,
      ablehnungGrund: r.ablehnungGrund,
    }))
    .sort((a, b) => rank[a.status] - rank[b.status] || b.verhaengtAm.getTime() - a.verhaengtAm.getTime());
}

/** Anzahl offener (noch nicht gemeldeter) Strafen — für den Dashboard-Hinweis. */
export async function countOffeneStrafen(userId: string): Promise<{ offen: number; gemeldet: number }> {
  const [offen, gemeldet] = await Promise.all([
    prisma.strafeRecord.count({ where: { userId, status: "PUNISHED", erledigtAt: null, gemeldetAt: null } }),
    prisma.strafeRecord.count({ where: { userId, status: "PUNISHED", erledigtAt: null, gemeldetAt: { not: null } } }),
  ]);
  return { offen, gemeldet };
}

/** Der Sub meldet eine Strafe als erledigt (optional mit Nachweis-Foto + Notiz). */
export async function meldeErledigung(
  userId: string,
  refId: string,
  opts?: { nachweisUrl?: string | null; notiz?: string | null },
): Promise<ServiceResult<{ refId: string }>> {
  const rec = await prisma.strafeRecord.findUnique({ where: { refId } });
  if (!rec || rec.userId !== userId) return { ok: false, status: 404, error: "Strafe nicht gefunden." };
  if (rec.status !== "PUNISHED") return { ok: false, status: 400, error: "Nur eine verhängte Strafe kann erledigt werden." };
  if (rec.erledigtAt) return { ok: false, status: 400, error: "Diese Strafe ist bereits erledigt." };
  if (rec.gemeldetAt) return { ok: false, status: 400, error: "Diese Erledigung wartet bereits auf Prüfung." };

  const nachweisUrl = opts?.nachweisUrl?.trim() || null;
  if (nachweisUrl && !isValidImageUrl(nachweisUrl)) return { ok: false, status: 400, error: "Ungültiger Bild-Pfad." };

  await prisma.strafeRecord.update({
    where: { refId },
    data: {
      gemeldetAt: new Date(),
      nachweisUrl,
      erledigungNotiz: opts?.notiz?.trim() || null,
      ablehnungGrund: null, // frischer Anlauf
    },
  });

  try {
    for (const c of await getControllersOfUser(userId)) {
      await notifyUser(c.id, {
        subjectKey: "penaltyReportedSubject",
        messageKey: rec.reason ? "penaltyReportedMessage" : "penaltyReportedMessagePlain",
        ...(rec.reason ? { params: { reason: rec.reason } } : {}),
      });
    }
  } catch { /* Benachrichtigung darf die Meldung nie verhindern */ }

  return { ok: true, data: { refId } };
}

/** Keyholderin/AI bestätigt eine gemeldete Erledigung → Loop geschlossen. */
export async function bestaetigeErledigung(userId: string, refId: string): Promise<ServiceResult<{ refId: string }>> {
  const rec = await prisma.strafeRecord.findUnique({ where: { refId } });
  if (!rec || rec.userId !== userId) return { ok: false, status: 404, error: "Strafe nicht gefunden." };
  if (rec.status !== "PUNISHED") return { ok: false, status: 400, error: "Nur eine verhängte Strafe kann erledigt werden." };
  if (rec.erledigtAt) return { ok: false, status: 400, error: "Diese Strafe ist bereits erledigt." };

  await prisma.strafeRecord.update({
    where: { refId },
    data: { erledigtAt: new Date(), ablehnungGrund: null },
  });
  await notifyUser(userId, {
    subjectKey: "penaltyConfirmedSubject",
    messageKey: rec.reason ? "penaltyConfirmedMessage" : "penaltyConfirmedMessagePlain",
    ...(rec.reason ? { params: { reason: rec.reason } } : {}),
  });
  return { ok: true, data: { refId } };
}

/** Keyholderin/AI lehnt eine gemeldete Erledigung ab → Strafe ist wieder offen. */
export async function lehneErledigungAb(
  userId: string,
  refId: string,
  grund: string,
): Promise<ServiceResult<{ refId: string }>> {
  const text = grund?.trim();
  if (!text) return { ok: false, status: 400, error: "Eine Begründung ist erforderlich." };
  const rec = await prisma.strafeRecord.findUnique({ where: { refId } });
  if (!rec || rec.userId !== userId) return { ok: false, status: 404, error: "Strafe nicht gefunden." };
  if (!rec.gemeldetAt) return { ok: false, status: 400, error: "Für diese Strafe liegt keine Meldung vor." };
  if (rec.erledigtAt) return { ok: false, status: 400, error: "Diese Strafe ist bereits erledigt." };

  await prisma.strafeRecord.update({
    where: { refId },
    data: { gemeldetAt: null, ablehnungGrund: text },
  });
  await notifyUser(userId, {
    subjectKey: "penaltyRejectedSubject",
    messageKey: "penaltyRejectedMessage",
    params: { text },
  });
  return { ok: true, data: { refId } };
}
