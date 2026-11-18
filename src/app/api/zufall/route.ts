import { NextRequest, NextResponse } from "next/server";
import { requireApi, requireKeyholderOrAdminApi } from "@/lib/authGuards";
import { serviceFailure } from "@/lib/serviceResult";
import { drawFromPool, getPoolOwner, listActiveManualPools } from "@/lib/zufallService";

/** GET: die aktiven, manuell auslösbaren Pools des eingeloggten Subs (nur id + name, KEINE Gewichte). */
export async function GET() {
  const session = await requireApi();
  if (session instanceof NextResponse) return session;
  const pools = await listActiveManualPools(session.user.id);
  return NextResponse.json({ pools });
}

/** POST { poolId }: eine Ziehung auslösen. Der Sub darf seine eigenen Pools ziehen; ein Keyholder/
 *  Admin darf die Pools eines von ihm betreuten Subs ziehen. */
export async function POST(req: NextRequest) {
  const session = await requireApi();
  if (session instanceof NextResponse) return session;

  const body = await req.json().catch(() => ({}));
  const poolId = typeof body.poolId === "string" ? body.poolId : "";
  if (!poolId) return NextResponse.json({ error: "ZUFALL_INVALID_INPUT" }, { status: 400 });

  const owner = await getPoolOwner(poolId);
  if (!owner) return NextResponse.json({ error: "ZUFALL_POOL_NOT_FOUND" }, { status: 404 });

  let drawnBy: "sub" | "keyholder";
  if (session.user.id === owner) {
    drawnBy = "sub";
  } else {
    const err = await requireKeyholderOrAdminApi(owner);
    if (err) return err;
    drawnBy = "keyholder";
  }

  const result = await drawFromPool(poolId, drawnBy);
  if (!result.ok) return serviceFailure(result);
  // Wahrscheinlichkeiten bleiben verborgen — nur das Ergebnis-Label + der Effekt gehen an den Client.
  return NextResponse.json(result.data);
}
