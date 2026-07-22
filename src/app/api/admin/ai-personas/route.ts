import { NextRequest, NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/authGuards";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const err = await requireAdminApi();
  if (err) return err;

  const personas = await prisma.aiPersona.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true, description: true, systemPrompt: true, appearance: true, seed: true, avatarPath: true },
  });
  return NextResponse.json(personas);
}

export async function POST(req: NextRequest) {
  const err = await requireAdminApi();
  if (err) return err;

  const { name, description, systemPrompt, appearance, seed } = await req.json();
  if (!name?.trim() || !systemPrompt?.trim()) {
    return NextResponse.json({ error: "name and systemPrompt required" }, { status: 400 });
  }

  const existing = await prisma.aiPersona.findUnique({ where: { name: name.trim() } });
  if (existing) {
    return NextResponse.json({ error: "nameExists" }, { status: 409 });
  }

  const persona = await prisma.aiPersona.create({
    data: { name: name.trim(), description: description?.trim() || null, systemPrompt: systemPrompt.trim(), appearance: appearance?.trim() || null, seed: (typeof seed === "number" && Number.isFinite(seed)) ? Math.trunc(seed) : null },
  });
  return NextResponse.json(persona, { status: 201 });
}
