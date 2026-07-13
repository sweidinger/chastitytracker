import { NextResponse } from "next/server";
import { requireKeyholderOrAdminApi } from "@/lib/authGuards";
import { grantBelohnung } from "@/lib/belohnung";

// Belohnungs-Fenster gewähren (Einlösen): merkt 1 Guthaben vor (Guthaben −1) und öffnet eine
// Orgasmus-Gelegenheit der Art "Belohnung". Voraussetzung: Guthaben ≥ 1, kein aktives Fenster.
export async function POST(req: Request) {
  const body = await req.json();
  const { userId, windowHours, oeffnenErlaubt } = body ?? {};
  if (!userId) return NextResponse.json({ error: "Missing userId" }, { status: 400 });

  const err = await requireKeyholderOrAdminApi(userId);
  if (err) return err;

  const res = await grantBelohnung(
    userId,
    typeof windowHours === "number" ? windowHours : undefined,
    oeffnenErlaubt !== false,
  );
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json(res.data, { status: 201 });
}
