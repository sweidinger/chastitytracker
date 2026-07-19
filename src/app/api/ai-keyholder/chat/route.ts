import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getKeyholderConfig, streamChatResponse, executeChatAction } from "@/lib/aiKeyholder/keyholderService";

/**
 * POST /api/ai-keyholder/chat
 * Body: { message: string }
 *
 * Streams the AI keyholder's reply as text/event-stream (SSE).
 * User message is persisted before streaming starts; assistant message is
 * persisted after the stream completes.
 *
 * If the AI includes an [ACTION:{...}] tag, it is stripped from the visible
 * text, executed server-side, and reported back as an `actionExecuted` SSE event.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { message } = await req.json() as { message?: string };
  if (!message?.trim()) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }

  const userId = session.user.id;
  const username = session.user.name ?? session.user.email ?? userId;

  const cfg = await getKeyholderConfig(userId);
  if (!cfg?.enabled) {
    return NextResponse.json({ error: "AI Keyholder nicht aktiviert" }, { status: 403 });
  }

  // Persist user message immediately
  await prisma.aiKeyholderMessage.create({
    data: { userId, role: "user", content: message.trim() },
  });

  // Stream the response
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const textChunks: string[] = [];
      try {
        for await (const item of streamChatResponse(userId, username, message.trim())) {
          if (typeof item === "string") {
            textChunks.push(item);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: item })}\n\n`));
          } else if ("chatAction" in item) {
            // Execute the action, then report result to client
            const result = await executeChatAction(userId, item.chatAction);
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ actionExecuted: result })}\n\n`),
            );
          }
        }

        // Persist complete assistant reply (text only, no action tag)
        const fullText = textChunks.join("");
        const saved = await prisma.aiKeyholderMessage.create({
          data: { userId, role: "assistant", content: fullText },
        });
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, messageId: saved.id })}\n\n`));
      } catch (e) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: String(e) })}\n\n`),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/**
 * GET /api/ai-keyholder/chat?limit=30
 * Returns recent chat history (user + assistant messages, newest last).
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  // parseInt("abc") = NaN → take: NaN → Prisma-Fehler → 500. Deshalb explizit absichern.
  const parsedLimit = Number.parseInt(url.searchParams.get("limit") ?? "30", 10);
  const limit = Math.min(Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 30, 100);

  // Die NEUESTEN N laden (desc + take), dann aufsteigend zurückgeben ("newest last", wie dokumentiert).
  const messages = await prisma.aiKeyholderMessage.findMany({
    where: { userId: session.user.id, role: { in: ["user", "assistant"] } },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, role: true, content: true, mediaId: true, createdAt: true },
  });

  return NextResponse.json({ messages: messages.reverse() });
}
