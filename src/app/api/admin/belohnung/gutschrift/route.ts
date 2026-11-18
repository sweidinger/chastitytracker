import { NextResponse } from "next/server";
import { requireKeyholderOrAdminApi } from "@/lib/authGuards";
import { grantGutschrift } from "@/lib/belohnung";

// +1 Belohnungs-Guthaben für ein erreichtes Trainingsziel gutschreiben (einmal pro Zeitraum je Ziel).
export async function POST(req: Request) {
  const body = await req.json();
  const { userId, categoryId, periodType, periodKey } = body ?? {};
  if (!userId || !periodType || !periodKey) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const err = await requireKeyholderOrAdminApi(userId);
  if (err) return err;

  const res = await grantGutschrift(userId, categoryId ?? null, periodType, periodKey);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json(res.data, { status: 201 });
}
