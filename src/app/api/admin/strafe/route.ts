import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { requireKeyholderOrAdminApi } from "@/lib/authGuards";
import { isUniqueConstraintOn } from "@/lib/prismaErrors";
import { notifyUser } from "@/lib/notify";
import { strafeVerhaengtNotice } from "@/lib/strafurteilService";
import { executePenaltyAction, type PenaltyAction } from "@/lib/penaltyActions";
import { bestaetigeErledigung, lehneErledigungAb } from "@/lib/strafErledigung";

export async function POST(req: Request) {
  const body = await req.json();
  const { userId, offenseType, refId, bestraftDatum, notiz, reason } = body;
  // Optionale Straf-Aktion (Phase 3): wird nach dem Straf-Eintrag ausgeführt.
  const action: PenaltyAction | null = body.action && typeof body.action.type === "string" ? body.action : null;
  // status: "PUNISHED" (bestraft, default) | "DISMISSED" (verworfen / keine Strafe)
  const status: string = body.status === "DISMISSED" ? "DISMISSED" : "PUNISHED";

  if (!userId || !offenseType || !refId) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }
  // Bei einer Strafe ist der Freitext (reason) Pflicht; ein Verwerfen darf leer sein.
  if (status === "PUNISHED" && !reason?.trim()) {
    return NextResponse.json({ error: "Missing penalty text" }, { status: 400 });
  }

  const err = await requireKeyholderOrAdminApi(userId);
  if (err) return err;
  if (!["KONTROLLANFORDERUNG", "OEFFNEN_ENTRY", "VERSCHLUSS_ANFORDERUNG", "FALSCHES_GERAET", "ORGASMUS_ANWEISUNG", "SESSION_VERSAEUMT", "EREKTION", "PAUSE_OVERAGE"].includes(offenseType)) {
    return NextResponse.json({ error: "Invalid offenseType" }, { status: 400 });
  }

  // IDOR check: verify the referenced record belongs to userId
  if (offenseType === "KONTROLLANFORDERUNG") {
    const ka = await prisma.kontrollAnforderung.findUnique({ where: { id: refId } });
    if (!ka || ka.userId !== userId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  } else if (offenseType === "VERSCHLUSS_ANFORDERUNG") {
    const va = await prisma.verschlussAnforderung.findUnique({ where: { id: refId } });
    if (!va || va.userId !== userId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  } else if (offenseType === "ORGASMUS_ANWEISUNG") {
    const oa = await prisma.orgasmusAnforderung.findUnique({ where: { id: refId } });
    if (!oa || oa.userId !== userId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  } else if (offenseType === "SESSION_VERSAEUMT") {
    const sa = await prisma.sessionAnforderung.findUnique({ where: { id: refId } });
    if (!sa || sa.userId !== userId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  } else {
    const entry = await prisma.entry.findUnique({ where: { id: refId } });
    if (!entry || entry.userId !== userId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Rely on @unique constraint on refId — catch P2002 for clean error
  try {
    const record = await prisma.strafeRecord.create({
      data: {
        userId,
        offenseType,
        refId,
        status,
        bestraftDatum: bestraftDatum ? new Date(bestraftDatum + "T12:00:00Z") : new Date(),
        notiz: notiz?.trim() || null,
        reason: reason?.trim() || null,
        judgedBy: "admin",
      },
    });
    // Konsistent zur MCP (judgeOffense): bei verhängter Strafe den Nutzer benachrichtigen.
    if (status === "PUNISHED") await notifyUser(userId, strafeVerhaengtNotice(reason?.trim() || null));

    // Straf-Aktion (Phase 3) ausführen — nur bei verhängter Strafe. Fehler brechen das Urteil NICHT ab
    // (der Straf-Eintrag bleibt), werden aber zurückgemeldet.
    let actionMessage: string | null = null;
    let actionError: string | null = null;
    if (status === "PUNISHED" && action) {
      const ar = await executePenaltyAction(userId, action);
      if (ar.ok) actionMessage = ar.data.message;
      else actionError = ar.error;
    }
    return NextResponse.json({ ...record, actionMessage, actionError }, { status: 201 });
  } catch (e: unknown) {
    if (isUniqueConstraintOn(e, "refId")) {
      return NextResponse.json({ error: "Already judged" }, { status: 409 });
    }
    throw e;
  }
}

export async function DELETE(req: Request) {
  const { refId } = await req.json();
  if (!refId) return NextResponse.json({ error: "Missing refId" }, { status: 400 });

  const record = await prisma.strafeRecord.findUnique({ where: { refId } });
  if (!record) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const err = await requireKeyholderOrAdminApi(record.userId);
  if (err) return err;

  await prisma.strafeRecord.delete({ where: { refId } });
  return NextResponse.json({ ok: true });
}

// Strafe als erledigt / wieder offen markieren (schließt bzw. öffnet den Loop).
// Zusätzlich: eine vom Sub GEMELDETE Erledigung prüfen — action "confirm" (abhaken) oder
// "reject" (mit Begründung zurück auf offen).
export async function PATCH(req: Request) {
  const { refId, done, action, grund } = await req.json();
  if (!refId) return NextResponse.json({ error: "Missing refId" }, { status: 400 });

  const record = await prisma.strafeRecord.findUnique({ where: { refId } });
  if (!record) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (record.status !== "PUNISHED") return NextResponse.json({ error: "Only a penalty can be completed" }, { status: 400 });

  const err = await requireKeyholderOrAdminApi(record.userId);
  if (err) return err;

  if (action === "confirm" || action === "reject") {
    const res = action === "confirm"
      ? await bestaetigeErledigung(record.userId, refId)
      : await lehneErledigungAb(record.userId, refId, grund ?? "");
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
    return NextResponse.json({ ok: true });
  }

  // Direktes Abhaken/Wiederöffnen durch die Keyholderin (ohne Meldung des Subs).
  await prisma.strafeRecord.update({
    where: { refId },
    data: done === false
      ? { erledigtAt: null, gemeldetAt: null, ablehnungGrund: null }
      : { erledigtAt: new Date() },
  });
  return NextResponse.json({ ok: true });
}
