import { prisma } from "@/lib/prisma";
import type { ServiceResult } from "@/lib/serviceResult";
import { notifyControllers, notifyUser } from "@/lib/notify";
import { getControllersOfUser } from "@/lib/keyholder";
import { isValidImageUrl } from "@/lib/constants";
import { reportPenaltyDone } from "@/lib/penaltyReport";

/**
 * Strafen-Erledigung — schließt den Loop einer verhängten Strafe.
 *
 * Ablauf: offen → der Sub meldet die Erledigung (optional mit Nachweis-Foto und Notiz) → „gemeldet"
 * (wartet auf Prüfung) → die Keyholderin (oder die AI) bestätigt (erledigtAt gesetzt) oder lehnt mit
 * Begründung ab (Meldung geleert, Strafe wieder offen). Der Sub kann nach einer Ablehnung erneut melden.
 *
 * Die Meldung selbst ist Upstreams `reportedDoneAt` (`penaltyReport.ts`) — EIN Meldeweg, Foto und
 * Notiz sind nur der Zusatz daran. Das Fork-Altfeld `gemeldetAt` (Meldungen vor dem Merge) wird nur
 * noch gelesen (`reportedDoneAt ?? gemeldetAt`) und beim Zurücksetzen mitgeleert.
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

/** Zeitpunkt der Erledigt-Meldung — Upstreams Feld, das Fork-Altfeld nur als Rückfall. */
export function gemeldetAm(r: { reportedDoneAt: Date | null; gemeldetAt?: Date | null }): Date | null {
  return r.reportedDoneAt ?? r.gemeldetAt ?? null;
}

export function strafStatus(r: { erledigtAt: Date | null; reportedDoneAt: Date | null; gemeldetAt?: Date | null }): StrafStatus {
  if (r.erledigtAt) return "erledigt";
  if (gemeldetAm(r)) return "gemeldet";
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
      // notiz als Fallback: Alt-Records (KI-Strafen aus dem Chat) haben reason == null.
      strafe: r.reason ?? r.notiz,
      verhaengtAm: r.bestraftDatum,
      gemeldetAt: gemeldetAm(r),
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
    prisma.strafeRecord.count({ where: { userId, status: "PUNISHED", erledigtAt: null, reportedDoneAt: null, gemeldetAt: null } }),
    prisma.strafeRecord.count({
      where: { userId, status: "PUNISHED", erledigtAt: null, OR: [{ reportedDoneAt: { not: null } }, { gemeldetAt: { not: null } }] },
    }),
  ]);
  return { offen, gemeldet };
}

/**
 * Der Sub meldet eine Strafe als erledigt (optional mit Nachweis-Foto + Notiz).
 *
 * Über Upstreams `reportPenaltyDone` — derselbe Stempel (`reportedDoneAt`), dieselbe Einmal-Regel,
 * dieselbe Keyholder-Meldung wie `/api/penalty-done`. Dieser Weg ergänzt nur den Nachweis. Anders als
 * der Fork vorher meldet ein zweiter Versuch keinen Fehler mehr, sondern ändert schlicht nichts.
 */
export async function meldeErledigung(
  userId: string,
  refId: string,
  opts?: { nachweisUrl?: string | null; notiz?: string | null },
): Promise<ServiceResult<{ refId: string }>> {
  const nachweisUrl = opts?.nachweisUrl?.trim() || null;
  if (nachweisUrl && !isValidImageUrl(nachweisUrl)) return { ok: false, status: 400, error: "INVALID_IMAGE_URL" };

  const res = await reportPenaltyDone(userId, refId, new Date(), {
    nachweisUrl,
    erledigungNotiz: opts?.notiz?.trim() || null,
  });
  if (!res.ok) return res;

  if (res.data.reported) {
    try {
      const sub = await prisma.user.findUnique({ where: { id: userId }, select: { username: true } });
      await notifyControllers(userId, await getControllersOfUser(userId), {
        subjectKey: "penaltyReportedDoneSubject",
        messageKey: "penaltyReportedDoneMessage",
        params: { username: sub?.username ?? "", penalty: res.data.penalty ?? "" },
      });
    } catch { /* Benachrichtigung darf die Meldung nie verhindern */ }
  }

  return { ok: true, data: { refId } };
}

/** Keyholderin/AI bestätigt eine gemeldete Erledigung → Loop geschlossen. */
export async function bestaetigeErledigung(userId: string, refId: string): Promise<ServiceResult<{ refId: string }>> {
  const rec = await prisma.strafeRecord.findUnique({ where: { refId } });
  if (!rec || rec.userId !== userId) return { ok: false, status: 404, error: "PENALTY_NOT_FOUND" };
  if (rec.status !== "PUNISHED") return { ok: false, status: 400, error: "PENALTY_NOT_PUNISHED" };
  if (rec.erledigtAt) return { ok: false, status: 400, error: "PENALTY_ALREADY_DONE" };

  await prisma.strafeRecord.update({
    where: { refId },
    data: { erledigtAt: new Date(), ablehnungGrund: null },
  });
  const text = rec.reason ?? rec.notiz;
  await notifyUser(userId, {
    subjectKey: "penaltyConfirmedSubject",
    messageKey: text ? "penaltyConfirmedMessage" : "penaltyConfirmedMessagePlain",
    ...(text ? { params: { reason: text } } : {}),
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
  if (!text) return { ok: false, status: 400, error: "PENALTY_REASON_REQUIRED" };
  const rec = await prisma.strafeRecord.findUnique({ where: { refId } });
  if (!rec || rec.userId !== userId) return { ok: false, status: 404, error: "PENALTY_NOT_FOUND" };
  if (!gemeldetAm(rec)) return { ok: false, status: 400, error: "PENALTY_NO_REPORT" };
  if (rec.erledigtAt) return { ok: false, status: 400, error: "PENALTY_ALREADY_DONE" };

  await prisma.strafeRecord.update({
    where: { refId },
    data: { reportedDoneAt: null, gemeldetAt: null, ablehnungGrund: text },
  });
  await notifyUser(userId, {
    subjectKey: "penaltyRejectedSubject",
    messageKey: "penaltyRejectedMessage",
    params: { text },
  });
  return { ok: true, data: { refId } };
}
