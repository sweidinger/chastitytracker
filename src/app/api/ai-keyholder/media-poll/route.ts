import { NextResponse } from "next/server";
import { processQueuedJobs, pollGeneratingJobs } from "@/lib/aiKeyholder/mediaQueue";

const CRON_SECRET = process.env.AI_KEYHOLDER_CRON_SECRET;

/**
 * POST /api/ai-keyholder/media-poll
 *
 * Cron endpoint — processes the media generation queue:
 *   1. Submits "queued" jobs to ComfyUI
 *   2. Polls "generating" jobs, downloads + saves completed files
 *
 * Protected by AI_KEYHOLDER_CRON_SECRET bearer token (same as /run).
 * Suggested schedule: every 2–5 minutes while generation is active.
 *
 * Example cron (crontab):
 *   * /2 * * * * curl -s -X POST http://localhost:3000/api/ai-keyholder/media-poll \
 *       -H "Authorization: Bearer <secret>"
 */
export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization");
  const provided = authHeader?.replace(/^Bearer\s+/, "");

  // When no secret is set OR wrong secret provided → require admin session fallback
  if (!CRON_SECRET || provided !== CRON_SECRET) {
    const { auth } = await import("@/lib/auth");
    const session = await auth();
    if (!session || session.user.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const [submitted, completed] = await Promise.all([
    processQueuedJobs(5),
    pollGeneratingJobs(),
  ]);

  return NextResponse.json({ ok: true, submitted, completed });
}
