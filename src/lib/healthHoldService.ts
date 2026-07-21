import { prisma } from "@/lib/prisma";
import type { ServiceResult } from "@/lib/serviceResult";
import { notifyUser } from "@/lib/notify";
import { getControllersOfUser } from "@/lib/keyholder";

/**
 * Gesundheits-Stopp (Health-Hold) — der Sub kann jederzeit selbst signalisieren, dass er eine Pause
 * braucht. Wirkung (bewusst zurückhaltend): der Status weist den Stopp aus, und die AI-Keyholderin
 * stellt KEINE neuen Anforderungen/Strafen mehr (harte Sperre in den Action-Executors). Bestehende
 * Sperren/Anforderungen bleiben unangetastet — der Stopp ist ein Signal, kein Not-Aus des Verschlusses.
 */

export interface ActiveHealthHold {
  id: string;
  reason: string;
  since: Date;
}

/** Aktiver Gesundheits-Stopp (oder null). */
export async function getActiveHealthHold(userId: string): Promise<ActiveHealthHold | null> {
  const h = await prisma.healthHold.findFirst({
    where: { userId, active: true },
    orderBy: { createdAt: "desc" },
    select: { id: true, reason: true, createdAt: true },
  });
  return h ? { id: h.id, reason: h.reason, since: h.createdAt } : null;
}

/** Schnellprüfung für die AI-Sperre. */
export async function isHealthHoldActive(userId: string): Promise<boolean> {
  return (await prisma.healthHold.count({ where: { userId, active: true } })) > 0;
}

/** Startet einen Gesundheits-Stopp (schließt einen evtl. laufenden). Benachrichtigt die Keyholder. */
export async function startHealthHold(userId: string, reason: string): Promise<ServiceResult<ActiveHealthHold>> {
  const text = reason?.trim();
  if (!text) return { ok: false, status: 400, error: "HEALTH_HOLD_REASON_REQUIRED" };

  const created = await prisma.$transaction(async (tx) => {
    await tx.healthHold.updateMany({
      where: { userId, active: true },
      data: { active: false, resolvedAt: new Date() },
    });
    return tx.healthHold.create({ data: { userId, active: true, reason: text } });
  });

  // Keyholder informieren — der Stopp ist ein Fürsorge-Signal und soll nicht untergehen.
  try {
    const controllers = await getControllersOfUser(userId);
    for (const c of controllers) {
      await notifyUser(c.id, {
        subjectKey: "healthHoldOnSubject",
        messageKey: "healthHoldOnMessage",
        params: { text },
      });
    }
  } catch { /* Benachrichtigung darf den Stopp nie verhindern */ }

  return { ok: true, data: { id: created.id, reason: created.reason, since: created.createdAt } };
}

/** Beendet den aktiven Gesundheits-Stopp. */
export async function resolveHealthHold(userId: string): Promise<ServiceResult<{ resolved: number }>> {
  const res = await prisma.healthHold.updateMany({
    where: { userId, active: true },
    data: { active: false, resolvedAt: new Date() },
  });
  if (res.count > 0) {
    try {
      const controllers = await getControllersOfUser(userId);
      for (const c of controllers) {
        await notifyUser(c.id, {
          subjectKey: "healthHoldOffSubject",
          messageKey: "healthHoldOffMessage",
        });
      }
    } catch { /* egal */ }
  }
  return { ok: true, data: { resolved: res.count } };
}
