import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/authGuards";
import { assignLock, releaseLock } from "@/lib/airlock/service";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/airlock/assign — ein Lock einem Sub zuweisen oder freigeben (tracker-intern, ohne
 * Airlock-Statuswechsel). Body: `{ action: "assign", userId, code }` oder `{ action: "release", code }`.
 * Erwartete Konflikte (unbekannter Code / gehört anderem Sub) → 409 mit stabilem Fehler-Token.
 */
export async function POST(req: Request) {
  const err = await requireAdminApi();
  if (err) return err;

  const body = (await req.json()) as { action?: string; userId?: string; code?: string };
  if (!body.code) return NextResponse.json({ error: "code required" }, { status: 400 });

  try {
    if (body.action === "release") {
      await releaseLock(body.code);
    } else if (body.action === "assign") {
      if (!body.userId) return NextResponse.json({ error: "userId required" }, { status: 400 });
      await assignLock(body.code, body.userId);
    } else {
      return NextResponse.json({ error: "action must be 'assign' or 'release'" }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "AIRLOCK_LOCK_NOT_FOUND" || msg === "AIRLOCK_LOCK_ASSIGNED_OTHER") {
      return NextResponse.json({ error: msg }, { status: 409 });
    }
    console.error("[POST /api/admin/airlock/assign]", e);
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
