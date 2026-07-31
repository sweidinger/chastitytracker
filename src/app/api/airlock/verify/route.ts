import { NextResponse } from "next/server";
import { requireApi } from "@/lib/authGuards";
import { checkRateLimit } from "@/lib/rate-limit";
import { verifyProof } from "@/lib/airlock/verify";

export const dynamic = "force-dynamic";

/**
 * POST /api/airlock/verify — prüft einen NFC-Tag-Nachweis auf Echtheit (Weg A, ruft die Airlock-API).
 * Der allgemeine „ist dieser Tag echt?"-Check für die Scan-UI (Phase 4) und zum Testen; die
 * Verschluss-/Kontroll-spezifische Bindung (zugewiesenes Lock / aktive UID) passiert in der
 * `entries`-Route. Antwortet mit 200 + `{ok:false, error}` bei ungültigem Tag (Verdikt, kein
 * HTTP-Fehler); 400 nur bei fehlender UID. Rate-limitiert (externer API-Call).
 */
export async function POST(req: Request) {
  const session = await requireApi();
  if (session instanceof NextResponse) return session;

  const rl = await checkRateLimit(`airlock-verify:${session.user.id}`, 10, 60_000);
  if (rl.limited) {
    return NextResponse.json({ ok: false, error: "Too many requests" }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });
  }

  const body = (await req.json()) as { uid?: string; code?: string; token?: string; ndefText?: string };
  if (!body.uid || (!(body.code && body.token) && !body.ndefText)) {
    return NextResponse.json({ ok: false, error: "AIRLOCK_TAG_INVALID" }, { status: 400 });
  }

  const res = await verifyProof({ uid: body.uid, code: body.code, token: body.token, ndefText: body.ndefText });
  if (!res.ok) return NextResponse.json({ ok: false, error: res.error });
  return NextResponse.json({ ok: true, code: res.code, uid: res.uid, status: res.status, boundUid: res.boundUid });
}
