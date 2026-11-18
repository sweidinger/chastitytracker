import { NextRequest, NextResponse } from "next/server";
import { requireKeyholderOrAdminApi } from "@/lib/authGuards";
import { airlockEnabled } from "@/lib/airlock/config";
import { getAssignedLocks } from "@/lib/airlock/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/airlock/assigned?userId=… — die einem Sub zugewiesenen Airlock-Locks (Pool), für das
 * „Lock vorgeben"-Dropdown im Verschluss-Anfordern-Dialog. Zugriff: Keyholderin/Admin (auf den Sub
 * bezogen — dieselbe Berechtigung wie das Anfordern selbst). Ist Airlock aus, kommt eine leere Liste
 * (Dropdown bleibt aus). Nur die Codes verlassen den Server, keine UID/Interna.
 */
export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId");
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  const err = await requireKeyholderOrAdminApi(userId);
  if (err) return err;

  if (!(await airlockEnabled())) return NextResponse.json({ locks: [] });
  const locks = await getAssignedLocks(userId);
  return NextResponse.json({ locks: locks.map((l) => ({ code: l.code })) });
}
