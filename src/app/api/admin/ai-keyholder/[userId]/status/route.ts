import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/authGuards";

/**
 * GET /api/admin/ai-keyholder/[userId]/status
 *
 * Returns live status for the AI Keyholder admin panel:
 *  - media queue counts per status
 *  - last 8 system messages (autonomous action log)
 *  - last 5 generated media items (newest first)
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const err = await requireAdminApi();
  if (err) return err;

  const { userId } = await params;

  const [mediaCounts, activityLog, recentMedia] = await Promise.all([
    // Aggregate counts by status
    prisma.generatedMedia.groupBy({
      by: ["status"],
      where: { userId },
      _count: { id: true },
    }),

    // Last autonomous action log entries (system messages)
    prisma.aiKeyholderMessage.findMany({
      where: { userId, role: "system" },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: { id: true, content: true, createdAt: true },
    }),

    // Most recent media items (any status)
    prisma.generatedMedia.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 12,
      select: {
        id: true,
        mediaType: true,
        status: true,
        prompt: true,
        filePath: true,
        failedReason: true,
        createdAt: true,
        assignedAt: true,
      },
    }),
  ]);

  // Normalize counts into a flat object
  const counts: Record<string, number> = {
    queued: 0,
    generating: 0,
    ready: 0,
    assigned: 0,
    failed: 0,
  };
  for (const row of mediaCounts) {
    counts[row.status] = row._count.id;
  }

  return NextResponse.json({
    counts,
    activityLog: activityLog.map((m) => ({
      id: m.id,
      content: m.content,
      createdAt: m.createdAt.toISOString(),
    })),
    recentMedia: recentMedia.map((m) => ({
      ...m,
      createdAt: m.createdAt.toISOString(),
      assignedAt: m.assignedAt?.toISOString() ?? null,
    })),
  });
}
