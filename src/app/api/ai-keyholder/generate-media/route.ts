import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/authGuards";
import { queueMediaGeneration, processQueuedJobs } from "@/lib/aiKeyholder/mediaQueue";

/**
 * POST /api/ai-keyholder/generate-media
 * Body: { userId: string }
 *
 * Queues a new media generation job for the given user and immediately
 * submits it to ComfyUI. Protected by admin session or cron secret.
 */
export async function POST(req: Request) {
  // Accept admin session OR cron secret
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.AI_KEYHOLDER_CRON_SECRET;
  // Only trust the cron secret when it is actually configured
  const isFromCron = !!cronSecret && authHeader?.replace(/^Bearer\s+/, "") === cronSecret;

  if (!isFromCron) {
    const err = await requireAdminApi();
    if (err) return err;
  }

  const { userId } = await req.json() as { userId?: string };
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const mediaId = await queueMediaGeneration(userId);
  const submitted = await processQueuedJobs(1);

  return NextResponse.json({ ok: true, mediaId, submitted });
}

/**
 * GET /api/ai-keyholder/generate-media?userId=...
 * Returns generated media for a user (admin or self).
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const userId = url.searchParams.get("userId") ?? session.user.id;

  // Non-admins can only see their own media
  if (userId !== session.user.id && session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const media = await prisma.generatedMedia.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      mediaType: true,
      status: true,
      prompt: true,
      filePath: true,
      createdAt: true,
      assignedAt: true,
      failedReason: true,
    },
  });

  return NextResponse.json({ media });
}
