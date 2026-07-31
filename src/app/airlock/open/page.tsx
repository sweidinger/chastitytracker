import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { aktiveKontrolleWhere } from "@/lib/queries";
import { getActiveAirlockCode } from "@/lib/airlock/service";
import { emitAirlockScanIncident } from "@/lib/airlock/incident";

export const dynamic = "force-dynamic";

const CHAT_ROUTE = "/dashboard/keyholder";

/**
 * /airlock/open?code=<airlockCode> — Landepunkt des Universal-Link-Antippens (AirlockDeepLinkRouter).
 * Löst den 5-stelligen Airlock-Code auf und leitet je nach Zustand weiter. Rendert nichts (immer
 * redirect). Szenario-Matrix: docs/UNIVERSAL_LINK_UMSETZUNG.md (+ Nachtrag).
 *
 *  A  nicht eingeloggt                      -> /            (neutral, Login greift)
 *  B/C unbekannt / fremdes Lock             -> /            (still — kein Leak über Existenz/Besitz)
 *  F/G aktiver offener CAGE-Antrag          -> /dashboard/new/pruefung?code=<antrag.code> (jüngster)
 *  H  nur zukünftig wirksam (wirksamAb>now) -> zählt als kein Antrag (aktiveKontrolleWhere) -> D/E
 *  E  mein Lock aktiv verschlossen, kein Antrag -> Vorfall (idempotent) + AI-Keyholder-Chat
 *  D  mein Lock, nicht verschlossen, kein Antrag -> /
 *
 * Die Echtheitsprüfung (In-App-UID-Scan) bleibt in der Prüfung unverändert; der Link identifiziert
 * nur WELCHES Lock/WELCHER Antrag gemeint ist — er ist KEIN Echtheitsnachweis.
 */
export default async function AirlockOpenPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const [{ code }, session] = await Promise.all([searchParams, auth()]);
  const userId = session?.user?.id;
  if (!userId) redirect("/"); // A

  const airlockCode = typeof code === "string" ? code.trim() : "";
  if (!airlockCode) redirect("/");

  const lock = await prisma.airlockLock.findUnique({ where: { code: airlockCode } });
  if (!lock || lock.assignedUserId !== userId) redirect("/"); // B & C (still, kein Popup)

  const now = new Date();

  // F/G: aktiver, offener CAGE-Antrag? (H: zukünftig wirksame fallen via aktiveKontrolleWhere raus)
  const open = await prisma.kontrollAnforderung.findFirst({
    where: {
      userId,
      device: "CAGE",
      entryId: null,
      withdrawnAt: null,
      ...aktiveKontrolleWhere(now),
    },
    orderBy: { createdAt: "desc" }, // G: jüngsten
  });
  if (open) redirect(`/dashboard/new/pruefung?code=${encodeURIComponent(open.code)}`); // F/G

  // E vs D: läuft für GENAU DIESES Lock eine aktive Verschließung?
  if ((await getActiveAirlockCode(userId)) === lock.code) {
    await emitAirlockScanIncident(userId, lock.code, now); // Vorfall an die Keyholderin (idempotent)
    redirect(CHAT_ROUTE); // E
  }

  redirect("/"); // D
}
