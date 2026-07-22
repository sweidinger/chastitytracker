import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { autoGrantReachedGoals } from "@/lib/belohnung";

/**
 * Cron-Endpunkt: schreibt erreichte Trainingsziele als Belohnungs-Guthaben gut — fuer ALLE Nutzer,
 * unabhaengig davon, ob sie eine KI-Keyholderin haben oder gerade jemand hinschaut.
 *
 * WARUM es das braucht: Zielerreichung ist zeitkontinuierlich (kumulierte Tragezeit gegen `now`),
 * kein DB-Ereignis — es gibt keinen Moment, an dem der Zaehler von selbst hochspringt. Der
 * Overview-Pfad (Keyholderin) und der Entry-Hook (Session-Ende) decken die Faelle ab, in denen
 * ohnehin gerechnet wird; dieser Cron ist das Sicherheitsnetz fuer einen Sub mit Admin-Keyholder
 * und fuer Ziele, die waehrend einer laufenden Session erreicht werden.
 *
 * Auth: geteiltes Cron-Secret (dasselbe wie der KI-Keyholder-Cron) ODER Admin-Session.
 * Nur Nutzer mit mindestens einer aktuell gueltigen Trainingsvorgabe werden geprueft.
 */
const CRON_SECRET = process.env.AI_KEYHOLDER_CRON_SECRET;

export async function POST(req: Request) {
  const providedSecret = req.headers.get("authorization")?.replace(/^Bearer\s+/, "");
  const isCron = !!CRON_SECRET && providedSecret === CRON_SECRET;
  if (!isCron) {
    const { auth } = await import("@/lib/auth");
    const session = await auth();
    if (!session || session.user.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const now = new Date();
  // Nur Nutzer mit aktiver Vorgabe — ohne Ziel gibt es nichts gutzuschreiben, und ein Full-Table-
  // Scan ueber alle Nutzer je Minute waere auf grossen Instanzen verschwenderisch.
  const vorgaben = await prisma.trainingVorgabe.findMany({
    where: { gueltigAb: { lte: now }, OR: [{ gueltigBis: null }, { gueltigBis: { gte: now } }] },
    select: { userId: true },
    distinct: ["userId"],
  });

  let totalCredited = 0;
  let usersWithCredit = 0;
  for (const { userId } of vorgaben) {
    try {
      const n = await autoGrantReachedGoals(userId, now);
      if (n > 0) { totalCredited += n; usersWithCredit++; }
    } catch { /* ein Nutzer-Fehler darf den Lauf nicht kippen */ }
  }

  return NextResponse.json({ checkedUsers: vorgaben.length, usersWithCredit, totalCredited });
}
