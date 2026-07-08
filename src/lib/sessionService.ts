/**
 * sessionService.ts — Session-Anforderung helpers (SESSION_BEGIN / SESSION_END).
 *
 * Parallel to kontrolleService / verschlussAnforderungService.
 * A SessionAnforderung is created by an Admin or AI Keyholder and fulfilled when
 * the user records a SESSION_END entry within the deadline.
 */
import { prisma } from "@/lib/prisma";
import type { PrismaTx } from "@/lib/queries";

// ── Queries ─────────────────────────────────────────────────────────────────

/** Returns the open (not fulfilled, not withdrawn, deadline not passed) SessionAnforderung
 *  for a user, optionally scoped to a device category.
 *  "Open" = the deadline window has not yet expired (endetAt >= now OR endetAt is null). */
export async function getActiveSessionAnforderung(
  userId: string,
  deviceCategoryId?: string,
  tx?: PrismaTx,
) {
  const client = tx ?? prisma;
  const now = new Date();
  return client.sessionAnforderung.findFirst({
    where: {
      userId,
      fulfilledAt: null,
      withdrawnAt: null,
      ...(deviceCategoryId ? { deviceCategoryId } : {}),
      OR: [{ endetAt: null }, { endetAt: { gte: now } }],
    },
    orderBy: { createdAt: "desc" },
    include: {
      deviceCategory: { select: { id: true, name: true, maxSessionMinutes: true, requiresVideo: true } },
    },
  });
}

/** Returns all open SessionAnforderungen for a user (all categories). */
export async function getAllActiveSessionAnforderungen(userId: string) {
  const now = new Date();
  return prisma.sessionAnforderung.findMany({
    where: {
      userId,
      fulfilledAt: null,
      withdrawnAt: null,
      OR: [{ endetAt: null }, { endetAt: { gte: now } }],
    },
    orderBy: { createdAt: "desc" },
    include: {
      deviceCategory: { select: { id: true, name: true, maxSessionMinutes: true, requiresVideo: true } },
    },
  });
}

/** Marks a SessionAnforderung as fulfilled by linking the SESSION_END entry.
 *  Must be called inside a transaction. */
export async function fulfillSessionAnforderung(
  anforderungId: string,
  sessionEndEntryId: string,
  tx: PrismaTx,
) {
  return tx.sessionAnforderung.update({
    where: { id: anforderungId },
    data: { fulfilledAt: new Date(), sessionEndId: sessionEndEntryId },
  });
}

export interface ActiveSessionRow {
  categoryId: string;
  categoryName: string;
  categoryColor: string;
  categoryIcon: string;
  deviceId: string | null;
  deviceName: string;
  since: Date;
}

/** Returns all currently active sessions across session categories (SESSION_BEGIN without later SESSION_END).
 *  Used by the dashboard to render session cards. */
export async function getActiveSessionsAllCategories(userId: string): Promise<ActiveSessionRow[]> {
  const latestPerDevice = await prisma.entry.findMany({
    where: { userId, type: { in: ["SESSION_BEGIN", "SESSION_END"] }, deviceId: { not: null } },
    orderBy: { startTime: "desc" },
    select: {
      type: true,
      startTime: true,
      deviceId: true,
      device: { select: { id: true, name: true, category: { select: { id: true, name: true, color: true, icon: true, isSessionCategory: true } } } },
    },
  });

  const seenDevices = new Set<string>();
  const sessions: ActiveSessionRow[] = [];
  for (const e of latestPerDevice) {
    if (!e.deviceId || seenDevices.has(e.deviceId)) continue;
    seenDevices.add(e.deviceId);
    if (e.type !== "SESSION_BEGIN" || !e.device?.category?.isSessionCategory) continue;
    sessions.push({
      categoryId: e.device.category.id,
      categoryName: e.device.category.name,
      categoryColor: e.device.category.color,
      categoryIcon: e.device.category.icon,
      deviceId: e.device.id,
      deviceName: e.device.name,
      since: e.startTime,
    });
  }
  return sessions;
}

/** Returns the latest SESSION_BEGIN entry for a device category that has no matching
 *  SESSION_END after it — i.e. the currently active session, or null. */
export async function getActiveSessionForCategory(
  userId: string,
  categoryId: string,
  tx?: PrismaTx,
): Promise<{ id: string; startTime: Date; deviceId: string | null } | null> {
  const client = tx ?? prisma;
  const latest = await client.entry.findFirst({
    where: {
      userId,
      type: { in: ["SESSION_BEGIN", "SESSION_END"] },
      device: { categoryId },
    },
    orderBy: { startTime: "desc" },
    select: { id: true, type: true, startTime: true, deviceId: true },
  });
  if (latest?.type !== "SESSION_BEGIN") return null;
  return { id: latest.id, startTime: latest.startTime, deviceId: latest.deviceId };
}
