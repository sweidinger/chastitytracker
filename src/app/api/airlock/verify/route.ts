import { NextResponse } from "next/server";
import { requireApi } from "@/lib/authGuards";
import { checkRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import { verifyProof, verifyForVerschluss, verifyForKontrolle } from "@/lib/airlock/verify";
import { getOpenLockRequest } from "@/lib/queries";

export const dynamic = "force-dynamic";

/**
 * POST /api/airlock/verify — prüft einen NFC-Tag-Nachweis auf Echtheit (Weg A, ruft die Airlock-API).
 * Für die Sofort-Rückmeldung im Scan-UI. Optionaler `mode` macht die Prüfung deckungsgleich mit dem
 * Speichern (entries-Route):
 *   - "verschluss": zusätzlich prüfen, ob es das richtige (vorgegebene/zugewiesene) Lock des Subs ist.
 *   - "kontrolle":  gegen die beim aktiven Verschluss gebundene UID prüfen.
 *   - ohne mode:    nur generische Echtheit (verifyProof).
 * Antwortet 200 + `{ok:false, error}` bei ungültigem Tag (Verdikt, kein HTTP-Fehler); 400 nur bei
 * fehlender UID. Rate-limitiert (externer API-Call).
 */
export async function POST(req: Request) {
  const session = await requireApi();
  if (session instanceof NextResponse) return session;

  const rl = await checkRateLimit(`airlock-verify:${session.user.id}`, 10, 60_000);
  if (rl.limited) {
    return NextResponse.json({ ok: false, error: "Too many requests" }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });
  }

  const body = (await req.json()) as {
    uid?: string; code?: string; token?: string; ndefText?: string; mode?: "verschluss" | "kontrolle";
  };
  if (!body.uid || (!(body.code && body.token) && !body.ndefText)) {
    return NextResponse.json({ ok: false, error: "AIRLOCK_TAG_INVALID" }, { status: 400 });
  }

  const proof = { uid: body.uid, code: body.code, token: body.token, ndefText: body.ndefText };

  let res;
  if (body.mode === "verschluss") {
    // Vorgabe aus der dringendsten offenen Anforderung (falls gesetzt) — identisch zur entries-Route.
    const mandate = await getOpenLockRequest(session.user.id);
    res = await verifyForVerschluss(session.user.id, proof, mandate?.airlockCode ?? null);
  } else if (body.mode === "kontrolle") {
    // Gegen die beim aktiven Verschluss gebundene UID prüfen (falls es einen aktiven Airlock-Verschluss gibt).
    const activeLock = await prisma.entry.findFirst({
      where: { userId: session.user.id, type: { in: ["VERSCHLUSS", "OEFFNEN"] } },
      orderBy: { startTime: "desc" },
      select: { type: true, airlockUid: true },
    });
    res =
      activeLock?.type === "VERSCHLUSS" && activeLock.airlockUid
        ? await verifyForKontrolle(activeLock.airlockUid, proof)
        : await verifyProof(proof);
  } else {
    res = await verifyProof(proof);
  }

  if (!res.ok) return NextResponse.json({ ok: false, error: res.error });
  return NextResponse.json({ ok: true, code: res.code, uid: res.uid, status: res.status, boundUid: res.boundUid });
}
