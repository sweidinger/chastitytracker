import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/authGuards";
import { queueMediaGeneration, processQueuedJobs } from "@/lib/aiKeyholder/mediaQueue";

/**
 * POST /api/ai-keyholder/generate-avatar
 * Body: { userId: string }
 *
 * Generates a portrait of the keyholder persona (persona anchor + fixed seed). Once the image
 * is ready, the media-poll cron sets it as the keyholder avatar (config.avatarPath).
 * Protected by admin session or cron secret.
 */
export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.AI_KEYHOLDER_CRON_SECRET;
  const isFromCron = !!cronSecret && authHeader?.replace(/^Bearer\s+/, "") === cronSecret;
  if (!isFromCron) {
    const err = await requireAdminApi();
    if (err) return err;
  }

  const { userId } = await req.json() as { userId?: string };
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  const cfg = await prisma.aiKeyholderConfig.findUnique({ where: { userId } });
  if (!cfg?.mediaEnabled) return NextResponse.json({ error: "Media generation not enabled" }, { status: 400 });

  // Portrait framing is used verbatim (literal); the persona anchor is prepended inside
  // queueMediaGeneration, so the avatar face matches the generated images.
  const portrait = "portrait, headshot, facing camera, upper body, neutral background, soft studio lighting, photorealistic, detailed face, sharp focus";
  const mediaId = await queueMediaGeneration(userId, { prompt: portrait, literal: true, isAvatar: true });
  const submitted = await processQueuedJobs(1);

  return NextResponse.json({ ok: true, mediaId, submitted });
}
