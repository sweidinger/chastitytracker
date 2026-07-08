/**
 * PATCH /api/admin/session-anforderung/[id]
 *   action: "withdraw"        — Anforderung zurückziehen
 *   action: "manuallyVerify"  — Anforderung manuell als erfüllt markieren
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/authGuards";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  const guard = await requireAdminApi();
  if (guard) return guard;

  const { id } = await params;
  const body = await req.json();
  const { action } = body;

  const anforderung = await prisma.sessionAnforderung.findUnique({ where: { id } });
  if (!anforderung) return NextResponse.json({ error: "Nicht gefunden" }, { status: 404 });
  if (anforderung.withdrawnAt || anforderung.fulfilledAt) {
    return NextResponse.json({ error: "Anforderung ist bereits abgeschlossen" }, { status: 409 });
  }

  if (action === "withdraw") {
    const updated = await prisma.sessionAnforderung.update({
      where: { id },
      data: { withdrawnAt: new Date() },
    });
    return NextResponse.json(updated);
  }

  if (action === "manuallyVerify") {
    const updated = await prisma.sessionAnforderung.update({
      where: { id },
      data: { fulfilledAt: new Date() },
    });
    return NextResponse.json(updated);
  }

  return NextResponse.json({ error: "Ungültige Aktion" }, { status: 400 });
}
