import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import KeyholderChatClient from "./KeyholderChatClient";
import { moodHintForSub } from "@/lib/aiKeyholder/moodService";

export default async function KeyholderPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const userId = session.user.id;

  const [cfg, messages, tasks] = await Promise.all([
    prisma.aiKeyholderConfig.findUnique({ where: { userId } }),
    prisma.aiKeyholderMessage.findMany({
      // Include system messages that contain event prefixes (Kontrolle / Strafe)
      // so they appear as event bubbles in the chat timeline.
      where: {
        userId,
        OR: [
          { role: { in: ["user", "assistant"] } },
          { role: "system", content: { contains: "[Kontrolle]" } },
          { role: "system", content: { contains: "[Strafe]" } },
          { role: "system", content: { contains: "[Anforderung]" } },
          { role: "system", content: { contains: "[Sperrzeit]" } },
        ],
      },
      // Die NEUESTEN 60 laden (desc + take), dann für die Anzeige wieder aufsteigend drehen.
      // Mit "asc" + take lieferte die Query die 60 ÄLTESTEN — der Chat fror ab Nachricht 61
      // am Gesprächsanfang ein und neue Nachrichten erschienen nach einem Reload nie.
      orderBy: { createdAt: "desc" },
      take: 60,
      select: { id: true, role: true, content: true, mediaId: true, imageUrl: true, createdAt: true },
    }),
    prisma.keyholderTask.findMany({
      where: { userId, completedAt: null },
      orderBy: { assignedAt: "desc" },
      include: {
        media: { select: { id: true, mediaType: true, filePath: true } },
      },
    }),
  ]);

  return (
    <>
      {cfg?.enabled && (
        <div className="w-full max-w-2xl mx-auto px-4 pt-3 text-center text-xs italic text-foreground-muted">
          {moodHintForSub({ moodScore: cfg.moodScore, moodUpdatedAt: cfg.moodUpdatedAt })}
        </div>
      )}
    <KeyholderChatClient
      enabled={cfg?.enabled ?? false}
      avatarPath={cfg?.avatarPath ?? null}
      initialMessages={[...messages].reverse().map((m) => ({
        id: m.id,
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
        mediaId: m.mediaId ?? undefined,
        imageUrl: m.imageUrl ?? undefined,
        createdAt: m.createdAt.toISOString(),
      }))}
      initialTasks={tasks.map((t) => ({
        id: t.id,
        type: t.type,
        message: t.message,
        assignedAt: t.assignedAt.toISOString(),
        dueAt: t.dueAt?.toISOString() ?? null,
        media: t.media
          ? { id: t.media.id, mediaType: t.media.mediaType, filePath: t.media.filePath }
          : null,
      }))}
    />
    </>
  );
}
