import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/authGuards";
import { syncAndListLocks } from "@/lib/airlock/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/airlock/locks — synchronisiert die Airlock-Registry in den lokalen Spiegel und gibt
 * die zusammengeführte Sicht (inkl. Zuweisung) zurück. Bei „nicht erreichbar" → 503, bei einem
 * HTTP-Fehler der Airlock-App → deren Status (bzw. 502). So kann das UI beide Zustände trennen.
 */
export async function GET() {
  const err = await requireAdminApi();
  if (err) return err;

  const res = await syncAndListLocks();
  if (!res.ok) {
    const status = res.unreachable ? 503 : (res.status ?? 502);
    return NextResponse.json(
      { ok: false, unreachable: res.unreachable, status: res.status, message: res.message },
      { status },
    );
  }
  return NextResponse.json({ ok: true, locks: res.data });
}
