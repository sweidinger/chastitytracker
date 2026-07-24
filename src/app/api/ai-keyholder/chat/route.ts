import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getKeyholderConfig, streamChatResponse, executeChatAction } from "@/lib/aiKeyholder/keyholderService";
import { applyMoodDelta, moodDeltaForAction } from "@/lib/aiKeyholder/moodService";

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

  const { message, imageUrl: rawImageUrl, entryId } = await req.json() as { message?: string; imageUrl?: string; entryId?: string };
  const userId = session.user.id;
  const username = session.user.name ?? session.user.email ?? userId;

  // Bildquelle aufloesen: entweder ein bestehender Eintrag des Subs (entryId, Ownership-geprueft) oder
  // ein frisch hochgeladener Dateiname (imageUrl). Ein blosser Dateiname ohne Pfad/Traversal.
  let imageUrl: string | null = null;
  if (entryId) {
    const entry = await prisma.entry.findFirst({ where: { id: entryId, userId }, select: { imageUrl: true } });
    imageUrl = entry?.imageUrl ?? null;
  } else if (rawImageUrl) {
    const name = rawImageUrl.split("/").pop() ?? "";
    imageUrl = name && !name.includes("..") ? name : null;
  }

  if (!message?.trim() && !imageUrl) {
    return NextResponse.json({ error: "message or image required" }, { status: 400 });
  }

  const cfg = await getKeyholderConfig(userId);
  if (!cfg?.enabled) {
    return NextResponse.json({ error: "AI Keyholder nicht aktiviert" }, { status: 403 });
  }

  // Persist user message immediately (mit optionalem Bild)
  const userText = message?.trim() || (imageUrl ? "Ich zeige dir dieses Foto." : "");
  await prisma.aiKeyholderMessage.create({
    data: { userId, role: "user", content: userText, imageUrl },
  });

  // Stream the response
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const textChunks: string[] = [];
      try {
        for await (const item of streamChatResponse(userId, username, userText)) {
          if (typeof item === "string") {
            textChunks.push(item);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: item })}\n\n`));
          } else if ("chatAction" in item) {
            // Execute the action, then report result to client
            const result = await executeChatAction(userId, item.chatAction);
            if (result.ok) await applyMoodDelta(userId, moodDeltaForAction(result.actionType)).catch(() => {});
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
    select: { id: true, role: true, content: true, mediaId: true, imageUrl: true, createdAt: true },
  });

  return NextResponse.json({ messages: messages.reverse() });
}
