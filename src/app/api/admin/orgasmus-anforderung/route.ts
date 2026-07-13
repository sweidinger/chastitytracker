import { NextRequest, NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/authGuards";
import { createOrgasmusAnforderung } from "@/lib/orgasmusAnforderungService";
import { grantBelohnung } from "@/lib/belohnung";

export async function POST(req: NextRequest) {
  try {
    const err = await requireAdminApi();
    if (err) return err;

    const { userId, art, nachricht, beginntAt, endetAt, vorgegebeneArt, oeffnenErlaubt, istStrafe, belohnung, fotoPflicht } = await req.json();

    // Belohnung-Checkbox: wie „Belohnung gewähren" — Guthaben −1 (≥1 nötig), Belohnungs-Fenster mit den
    // gewählten Zeiten. Öffnen ist bei einer Belohnung immer erlaubt (Orgasmus soll durchführbar sein).
    if (belohnung) {
      if (!userId) return NextResponse.json({ error: "userId fehlt" }, { status: 400 });
      const begin = beginntAt ? new Date(beginntAt) : undefined;
      const end = endetAt ? new Date(endetAt) : undefined;
      const res = await grantBelohnung(userId, undefined, true, { beginntAt: begin, endetAt: end, nachricht, fotoPflicht: Boolean(fotoPflicht) });
      if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
      return NextResponse.json({ ok: true, id: res.data.id });
    }

    const result = await createOrgasmusAnforderung({
      userId, art, nachricht, beginntAt, endetAt, vorgegebeneArt, oeffnenErlaubt, istStrafe, fotoPflicht,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ ok: true, id: result.data.id });
  } catch (err) {
    console.error("[POST /api/admin/orgasmus-anforderung]", err);
    return NextResponse.json({ error: "Interner Fehler" }, { status: 500 });
  }
}
