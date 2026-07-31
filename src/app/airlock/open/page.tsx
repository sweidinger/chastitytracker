import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { aktiveKontrolleWhere } from "@/lib/queries";

export const dynamic = "force-dynamic";

/**
 * /airlock/open?code=<airlockCode> — Landepunkt des Universal-Link-Antippens (siehe
 * AirlockDeepLinkRouter). Löst den 5-stelligen Airlock-Code zur offenen CAGE-Kontrollanforderung
 * des eingeloggten Subs auf und leitet in die Prüfung. Rendert nichts (immer redirect).
 *
 * Kantenlogik (docs/UNIVERSAL_LINK_UMSETZUNG.md §A.5):
 *  - nicht eingeloggt             → /login
 *  - unbekannter/fremder Code     → / (neutraler Home, kein Fehler/Popup)
 *  - keine offene CAGE-Kontrolle  → / (Home)
 *  - genau eine (bzw. jüngste)    → /dashboard/new/pruefung?code=<kontrollCode>
 *
 * Die Echtheitsprüfung (In-App-UID-Scan) bleibt in der Prüfung unverändert; der Link identifiziert
 * nur WELCHE Anforderung, er ist KEIN Echtheitsnachweis.
 */
export default async function AirlockOpenPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const [{ code }, session] = await Promise.all([searchParams, auth()]);
  const userId = session?.user?.id;
  if (!userId) redirect("/login");

  const airlockCode = typeof code === "string" ? code.trim() : "";
  if (!airlockCode) redirect("/");

  const lock = await prisma.airlockLock.findUnique({ where: { code: airlockCode } });
  // Unbekannter Code ODER Lock gehört nicht dem antippenden Sub → neutraler Home.
  if (!lock || lock.assignedUserId !== userId) redirect("/");

  const now = new Date();
  const open = await prisma.kontrollAnforderung.findFirst({
    where: {
      userId,
      device: "CAGE", // Airlock = Käfig; CAGE/PLUG-Trennung bleibt (max. 1 pro Gerät)
      entryId: null, // noch keine erfüllende PRUEFUNG
      withdrawnAt: null,
      ...aktiveKontrolleWhere(now), // geplante, noch nicht ausgelöste Kontrollen ausblenden
    },
    orderBy: { createdAt: "desc" }, // „jüngste" — praktisch ohnehin max. 1
  });

  if (!open) redirect("/");
  redirect(`/dashboard/new/pruefung?code=${encodeURIComponent(open.code)}`);
}
