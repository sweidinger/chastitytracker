import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/authGuards";

/**
 * DELETE /api/admin/ai-keyholder/[userId]/messages
 * Deletes the AI keyholder's conversation history (AiKeyholderMessage) and
 * long-term memory notes (KeyholderNote) for the given user.
 * Returns counts of deleted records.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const err = await requireAdminApi();
  if (err) return err;

  const { userId } = await params;

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const [messages, notes] = await Promise.all([
    prisma.aiKeyholderMessage.deleteMany({ where: { userId } }),
    prisma.keyholderNote.deleteMany({ where: { userId } }),
  ]);

  return NextResponse.json({
    deleted: { messages: messages.count, notes: notes.count },
  });
}
