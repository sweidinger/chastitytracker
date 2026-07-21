import { NextRequest, NextResponse } from "next/server";
import { requireKeyholderOrAdminApi } from "@/lib/authGuards";
import { createOrgasmusAnforderung } from "@/lib/orgasmusAnforderungService";
import { serviceFailure, errorResponse } from "@/lib/serviceResult";
import { grantBelohnung } from "@/lib/belohnung";

export async function POST(req: NextRequest) {
  try {
    const { userId, art, nachricht, beginntAt, endetAt, vorgegebeneArt, oeffnenErlaubt, istStrafe, belohnung, fotoPflicht } = await req.json();

    const err = await requireKeyholderOrAdminApi(userId);
    if (err) return err;

    // Fork: Belohnung-Checkbox wirkt wie „Belohnung gewaehren" — Guthaben -1 (>=1 noetig),
    // Belohnungs-Fenster mit den gewaehlten Zeiten. Oeffnen ist dabei immer erlaubt, sonst waere
    // der Orgasmus nicht durchfuehrbar.
    if (belohnung) {
      const begin = beginntAt ? new Date(beginntAt) : undefined;
      const end = endetAt ? new Date(endetAt) : undefined;
      const res = await grantBelohnung(userId, undefined, true, { beginntAt: begin, endetAt: end, nachricht, fotoPflicht: Boolean(fotoPflicht) });
      if (!res.ok) return serviceFailure(res);
      return NextResponse.json({ ok: true, id: res.data.id });
    }

    const result = await createOrgasmusAnforderung({
      userId, art, nachricht, beginntAt, endetAt, vorgegebeneArt, oeffnenErlaubt, istStrafe, fotoPflicht,
    });
    if (!result.ok) return serviceFailure(result);
    return NextResponse.json({ ok: true, id: result.data.id });
  } catch (err) {
    console.error("[POST /api/admin/orgasmus-anforderung]", err);
    return errorResponse(500, "INTERNAL_ERROR");
  }
}
