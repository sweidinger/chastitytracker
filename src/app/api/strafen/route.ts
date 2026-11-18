import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getStrafenForSub, meldeErledigung } from "@/lib/strafErledigung";

/** Eigene verhängte Strafen des Subs (offen / gemeldet / erledigt). */
export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ strafen: await getStrafenForSub(session.user.id) });
}

/** Eine Strafe als erledigt melden (optional mit Nachweis-Foto + Notiz) → wartet auf Prüfung. */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null) as { refId?: string; nachweisUrl?: string; notiz?: string } | null;
  if (!body?.refId) return NextResponse.json({ error: "refId erforderlich" }, { status: 400 });

  const res = await meldeErledigung(session.user.id, body.refId, {
    nachweisUrl: body.nachweisUrl ?? null,
    notiz: body.notiz ?? null,
  });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({ ok: true });
}
