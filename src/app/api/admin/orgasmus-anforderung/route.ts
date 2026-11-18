import { NextRequest, NextResponse } from "next/server";
import { requireKeyholderOrAdminActor, sessionActor } from "@/lib/authGuards";
import { createOrgasmusAnforderung } from "@/lib/orgasmusAnforderungService";
import { serviceFailure, errorResponse } from "@/lib/serviceResult";
import { grantBelohnung } from "@/lib/belohnung";

export async function POST(req: NextRequest) {
  try {
    const { userId, art, message, beginsAt, endsAt, requiredType, openingAllowed, delayMinutes, wirksamAbAt, istStrafe, belohnung, fotoPflicht } = await req.json();

    const actor = await requireKeyholderOrAdminActor(userId);
    if (actor instanceof NextResponse) return actor;

    // Fork: Belohnung-Checkbox wirkt wie „Belohnung gewaehren" — Guthaben -1 (>=1 noetig),
    // Belohnungs-Fenster mit den gewaehlten Zeiten. Oeffnen ist dabei immer erlaubt, sonst waere
    // der Orgasmus nicht durchfuehrbar.
    if (belohnung) {
      const begin = beginsAt ? new Date(beginsAt) : undefined;
      const end = endsAt ? new Date(endsAt) : undefined;
      const res = await grantBelohnung(userId, sessionActor(actor), undefined, true, { beginsAt: begin, endsAt: end, message, fotoPflicht: Boolean(fotoPflicht) });
      if (!res.ok) return serviceFailure(res);
      return NextResponse.json({ ok: true, id: res.data.id });
    }

    const result = await createOrgasmusAnforderung(
      { userId, art, message, beginsAt, endsAt, requiredType, openingAllowed, delayMinutes, wirksamAbAt, istStrafe, fotoPflicht },
      sessionActor(actor),
    );
    if (!result.ok) return serviceFailure(result);
    return NextResponse.json({ ok: true, id: result.data.id });
  } catch (err) {
    console.error("[POST /api/admin/orgasmus-anforderung]", err);
    return errorResponse(500, "INTERNAL_ERROR");
  }
}
