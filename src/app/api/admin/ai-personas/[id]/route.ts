import { NextRequest, NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/authGuards";
import { prisma } from "@/lib/prisma";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const err = await requireAdminApi();
  if (err) return err;

  const { id } = await params;
  const { name, description, systemPrompt, appearance, seed } = await req.json();
  if (!name?.trim() || !systemPrompt?.trim()) {
    return NextResponse.json({ error: "name and systemPrompt required" }, { status: 400 });
  }

  // Check name collision with a different record
  const collision = await prisma.aiPersona.findFirst({
    where: { name: name.trim(), NOT: { id } },
  });
  if (collision) {
    return NextResponse.json({ error: "nameExists" }, { status: 409 });
  }

  const persona = await prisma.aiPersona.update({
    where: { id },
    data: { name: name.trim(), description: description?.trim() || null, systemPrompt: systemPrompt.trim(), appearance: appearance?.trim() || null, seed: (typeof seed === "number" && Number.isFinite(seed)) ? Math.trunc(seed) : null },
  });
  return NextResponse.json(persona);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const err = await requireAdminApi();
  if (err) return err;

  const { id } = await params;
  await prisma.aiPersona.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
