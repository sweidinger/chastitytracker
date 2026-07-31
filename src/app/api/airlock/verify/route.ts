import { NextResponse } from "next/server";
import { requireApi } from "@/lib/authGuards";
import { checkRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import { verifyProof, verifyForVerschluss, verifyForKontrolle, verifyForAssignment } from "@/lib/airlock/verify";
import { markLockVerified } from "@/lib/airlock/service";
import { getOpenLockRequest } from "@/lib/queries";

export const dynamic = "force-dynamic";

/**
 * POST /api/airlock/verify — prüft einen NFC-Tag-Nachweis (Weg A). Sofort-Rückmeldung im Scan-UI.
 * `mode`:
 *   - "verschluss": zusätzlich prüfen, ob es das richtige (vorgegebene/zugewiesene) Lock des Subs ist.
 *   - "kontrolle":  gegen die beim aktiven Verschluss gebundene UID prüfen.
 *   - "verify":     Vorab-Verifikation eines ZUGEWIESENEN Locks (Sicherheits-Feature) — echt + gehört
 *                   dem Sub + UID passt → markiert das Lock als verifiziert (AirlockLock.verifiedAt).
 *   - ohne mode:    nur generische Echtheit (verifyProof).
 * 200 + `{ok:false, error}` bei ungültigem Tag; 400 nur bei fehlender UID. Rate-limitiert.
 */
export async function POST(req: Request) {
  const session = await requireApi();
  if (session instanceof NextResponse) return session;

  const rl = await checkRateLimit(`airlock-verify:${session.user.id}`, 10, 60_000);
  if (rl.limited) {
    return NextResponse.json({ ok: false, error: "Too many requests" }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });
  }

  const body = (await req.json()) as {
    uid?: string; code?: string; token?: string; ndefText?: string;
    mode?: "verschluss" | "kontrolle" | "verify";
  };
  if (!body.uid || (!(body.code && body.token) && !body.ndefText)) {
    return NextResponse.json({ ok: false, error: "AIRLOCK_TAG_INVALID" }, { status: 400 });
  }

  const proof = { uid: body.uid, code: body.code, token: body.token, ndefText: body.ndefText };

  let res;
  if (body.mode === "verschluss") {
    const mandate = await getOpenLockRequest(session.user.id);
    res = await verifyForVerschluss(session.user.id, proof, mandate?.airlockCode ?? null);
  } else if (body.mode === "kontrolle") {
    const activeLock = await prisma.entry.findFirst({
      where: { userId: session.user.id, type: { in: ["VERSCHLUSS", "OEFFNEN"] } },
      orderBy: { startTime: "desc" },
      select: { type: true, airlockUid: true },
    });
    res =
      activeLock?.type === "VERSCHLUSS" && activeLock.airlockUid
        ? await verifyForKontrolle(activeLock.airlockUid, proof)
        : await verifyProof(proof);
  } else if (body.mode === "verify") {
    res = await verifyForAssignment(session.user.id, proof);
    if (res.ok) await markLockVerified(res.code, session.user.id);
  } else {
    res = await verifyProof(proof);
  }

  if (!res.ok) return NextResponse.json({ ok: false, error: res.error });
  return NextResponse.json({ ok: true, code: res.code, uid: res.uid, status: res.status, boundUid: res.boundUid });
}
