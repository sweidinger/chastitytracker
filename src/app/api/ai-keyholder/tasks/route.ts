import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { completeTask } from "@/lib/aiKeyholder/keyholderService";

/**
 * GET /api/ai-keyholder/tasks?completed=false
 * Returns the user's keyholder tasks (open by default).
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const showCompleted = url.searchParams.get("completed") === "true";

  const tasks = await prisma.keyholderTask.findMany({
    where: {
      userId: session.user.id,
      completedAt: showCompleted ? { not: null } : null,
    },
    orderBy: { assignedAt: "desc" },
    take: 20,
    include: {
      media: {
        select: { id: true, mediaType: true, filePath: true, status: true },
      },
    },
  });

  return NextResponse.json({ tasks });
}

/**
 * PATCH /api/ai-keyholder/tasks/[id]
 * Body: { responseText: string }
 * Marks a task as complete and triggers the AI keyholder's reaction.
 *
 * Note: task ID is in the body, not the URL, since Next.js dynamic routes
 * require a separate file. This single-route approach avoids extra files.
 */
export async function PATCH(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { taskId, responseText } = await req.json() as {
    taskId?: string;
    responseText?: string;
  };

  if (!taskId) return NextResponse.json({ error: "taskId required" }, { status: 400 });
  if (!responseText?.trim()) {
    return NextResponse.json({ error: "responseText required" }, { status: 400 });
  }

  const userId = session.user.id;
  const username = session.user.name ?? session.user.email ?? userId;

  try {
    const result = await completeTask(userId, username, taskId, responseText.trim());
    return NextResponse.json({ ok: true, aiReactionText: result.aiReactionText });
  } catch (e) {
    const msg = String(e);
    // "nicht gefunden" → 404, everything else → 400
    const status = msg.includes("nicht gefunden") ? 404 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}
