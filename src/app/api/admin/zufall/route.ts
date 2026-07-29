import { NextRequest, NextResponse } from "next/server";
import { requireApi, requireKeyholderOrAdminApi } from "@/lib/authGuards";
import { serviceFailure, serviceResponse } from "@/lib/serviceResult";
import {
  createZufallsPool, updateZufallsPool, deleteZufallsPool, setPoolOptions,
  listZufallsPools, getPoolOwner, type ZufallsOptionInput,
} from "@/lib/zufallService";

/** GET ?userId — alle Pools (mit Optionen) eines betreuten Subs. */
export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "";
  if (!userId) return NextResponse.json({ error: "USER_ID_REQUIRED" }, { status: 400 });
  const err = await requireKeyholderOrAdminApi(userId);
  if (err) return err;
  const pools = await listZufallsPools(userId);
  return NextResponse.json({ pools });
}

/** POST — neuen Pool anlegen (optional mit Optionen). */
export async function POST(req: NextRequest) {
  const session = await requireApi();
  if (session instanceof NextResponse) return session;
  const body = await req.json().catch(() => ({}));
  const err = await requireKeyholderOrAdminApi(body.userId);
  if (err) return err;

  const result = await createZufallsPool({
    userId: body.userId,
    name: body.name,
    aktiv: body.aktiv,
    triggerType: body.triggerType,
    cooldownMin: body.cooldownMin ?? null,
    maxAddH: body.maxAddH ?? null,
    createdBy: session.user.role === "admin" ? "admin" : "keyholder",
    options: body.options as ZufallsOptionInput[] | undefined,
  });
  if (!result.ok) return serviceFailure(result);
  return NextResponse.json({ id: result.data.id }, { status: 201 });
}

/** PATCH { id, ...poolPatch, options? } — Pool-Felder aktualisieren und/oder Optionen ersetzen. */
export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "ZUFALL_INVALID_INPUT" }, { status: 400 });
  const owner = await getPoolOwner(id);
  if (!owner) return NextResponse.json({ error: "ZUFALL_POOL_NOT_FOUND" }, { status: 404 });
  const err = await requireKeyholderOrAdminApi(owner);
  if (err) return err;

  const hasPoolFields = ["name", "aktiv", "cooldownMin", "maxAddH"].some((k) => k in body);
  if (hasPoolFields) {
    const res = await updateZufallsPool(id, {
      name: body.name,
      aktiv: body.aktiv,
      cooldownMin: body.cooldownMin,
      maxAddH: body.maxAddH,
    });
    if (!res.ok) return serviceFailure(res);
  }
  if (Array.isArray(body.options)) {
    const res = await setPoolOptions(id, body.options as ZufallsOptionInput[]);
    if (!res.ok) return serviceFailure(res);
  }
  return NextResponse.json({ ok: true });
}

/** DELETE ?id — Pool (samt Optionen + Ziehungshistorie) löschen. */
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ error: "ZUFALL_INVALID_INPUT" }, { status: 400 });
  const owner = await getPoolOwner(id);
  if (!owner) return NextResponse.json({ error: "ZUFALL_POOL_NOT_FOUND" }, { status: 404 });
  const err = await requireKeyholderOrAdminApi(owner);
  if (err) return err;
  return serviceResponse(await deleteZufallsPool(id));
}
