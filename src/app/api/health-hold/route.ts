import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { startHealthHold, resolveHealthHold, getActiveHealthHold } from "@/lib/healthHoldService";

/** GET — aktiver Gesundheits-Stopp des eingeloggten Users (oder null). */
export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const hold = await getActiveHealthHold(session.user.id);
  return NextResponse.json({ hold });
}

/** POST — Gesundheits-Stopp aktivieren. Der Sub darf das jederzeit für sich selbst tun. */
export async function POST(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const res = await startHealthHold(session.user.id, typeof body?.reason === "string" ? body.reason : "");
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json(res.data, { status: 201 });
}

/** DELETE — Gesundheits-Stopp beenden (nur der Sub selbst). */
export async function DELETE() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const res = await resolveHealthHold(session.user.id);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json(res.data);
}
