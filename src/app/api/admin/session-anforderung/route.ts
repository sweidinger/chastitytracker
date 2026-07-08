/**
 * POST /api/admin/session-anforderung — Admin/Keyholder erstellt eine Session-Anforderung.
 * GET  /api/admin/session-anforderung — Liste aller offenen Session-Anforderungen (Admin).
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/authGuards";
import { sendMail } from "@/lib/mail";
import { sendPushToUser } from "@/lib/push";

export async function GET(req: NextRequest) {
  const guard = await requireAdminApi();
  if (guard) return guard;

  const userId = req.nextUrl.searchParams.get("userId");
  const now = new Date();
  const where = {
    fulfilledAt: null,
    withdrawnAt: null,
    OR: [{ endetAt: null }, { endetAt: { gte: now } }],
    ...(userId ? { userId } : {}),
  };

  const anforderungen = await prisma.sessionAnforderung.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      user: { select: { id: true, username: true } },
      deviceCategory: { select: { id: true, name: true, maxSessionMinutes: true, requiresVideo: true } },
    },
  });
  return NextResponse.json(anforderungen);
}

export async function POST(req: NextRequest) {
  const guard = await requireAdminApi();
  if (guard) return guard;
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { userId, deviceCategoryId, nachricht, deadlineHours, minMinuten, requireVideo, delayMinutes, deviceId } = body;

  if (!userId || typeof userId !== "string") {
    return NextResponse.json({ error: "userId ist erforderlich" }, { status: 400 });
  }
  if (!deviceCategoryId || typeof deviceCategoryId !== "string") {
    return NextResponse.json({ error: "deviceCategoryId ist erforderlich" }, { status: 400 });
  }

  // Verify the target user exists and the category belongs to them and is a session category
  const [user, category] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true, email: true } }),
    prisma.deviceCategory.findUnique({
      where: { id: deviceCategoryId },
      select: { id: true, name: true, userId: true, isSessionCategory: true, maxSessionMinutes: true, requiresVideo: true },
    }),
  ]);
  if (!user) return NextResponse.json({ error: "Benutzer nicht gefunden" }, { status: 404 });
  if (!category || category.userId !== userId) return NextResponse.json({ error: "Kategorie nicht gefunden" }, { status: 404 });
  if (!category.isSessionCategory) {
    return NextResponse.json({ error: "Kategorie ist keine Session-Kategorie" }, { status: 400 });
  }

  // Bestimmtes Gerät (optional) muss zur Kategorie gehören.
  let validDeviceId: string | null = null;
  if (deviceId && typeof deviceId === "string") {
    const dev = await prisma.device.findFirst({
      where: { id: deviceId, userId, categoryId: deviceCategoryId, archivedAt: null },
      select: { id: true },
    });
    if (!dev) return NextResponse.json({ error: "Gerät gehört nicht zu dieser Kategorie" }, { status: 400 });
    validDeviceId = dev.id;
  }

  const nowMs = Date.now();
  const wirksamAb = typeof delayMinutes === "number" && delayMinutes > 0
    ? new Date(nowMs + delayMinutes * 60 * 1000)
    : null;
  // Frist läuft ab Auslösung (sofort = jetzt, geplant = wirksamAb).
  const startBase = wirksamAb ? wirksamAb.getTime() : nowMs;
  const endetAt = typeof deadlineHours === "number" && deadlineHours > 0
    ? new Date(startBase + deadlineHours * 60 * 60 * 1000)
    : null;
  const minMin = typeof minMinuten === "number" && minMinuten > 0
    ? Math.min(Math.round(minMinuten), category.maxSessionMinutes)
    : null;

  const anforderung = await prisma.sessionAnforderung.create({
    data: {
      userId,
      deviceCategoryId,
      nachricht: typeof nachricht === "string" ? nachricht.trim() || null : null,
      endetAt,
      minMinuten: minMin,
      requireVideo: Boolean(requireVideo) || category.requiresVideo,
      wirksamAb,
      deviceId: validDeviceId,
    },
    include: {
      deviceCategory: { select: { id: true, name: true, maxSessionMinutes: true, requiresVideo: true } },
    },
  });

  // Notifications (fire-and-forget)
  const pushBody = nachricht?.trim() || `Session mit ${category.name} gefordert${endetAt ? ` (bis ${endetAt.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })})` : ""}`;
  sendPushToUser(userId, "Session-Anforderung", pushBody, "/dashboard/new/session-begin").catch(() => {});

  if (user.email) {
    const deadline = endetAt
      ? `<br>Deadline: <strong>${endetAt.toLocaleString("de-DE")}</strong>`
      : "";
    const text = nachricht?.trim() ? `<p>${nachricht.trim()}</p>` : "";
    sendMail(
      user.email,
      `Session-Anforderung: ${category.name}`,
      `<p>Du hast eine Session-Anforderung erhalten.</p>${text}<p>Kategorie: <strong>${category.name}</strong> · Max. ${category.maxSessionMinutes} Min.${category.requiresVideo ? " · Video-Beweis erforderlich" : ""}</p>${deadline}`,
    ).catch(() => {});
  }

  return NextResponse.json(anforderung, { status: 201 });
}
