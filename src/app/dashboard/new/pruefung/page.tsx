import Link from "next/link";
import PruefungForm from "../../PruefungForm";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateKontrollCode, sealRequiredForCode } from "@/lib/kontrolleService";
import { getLatestKgEntry } from "@/lib/queries";
import { getTranslations } from "next-intl/server";
import { nowDatetimeLocal, APP_TZ } from "@/lib/utils";

export default async function NewPruefungPage({ searchParams }: { searchParams: Promise<{ code?: string; kommentar?: string; device?: string }> }) {
  const [{ code, kommentar, device }, session] = await Promise.all([searchParams, auth()]);
  const userId = session?.user?.id;
  const tz = session?.user?.timezone ?? APP_TZ;

  const [dbUser, latest] = await Promise.all([
    userId ? prisma.user.findUnique({ where: { id: userId }, select: { mobileDesktopUpload: true } }) : null,
    userId ? getLatestKgEntry(userId) : null,
  ]);

  // Angeforderter Code (Mail-Link) hat Vorrang.
  // Selbstkontrolle: Frische-Code nur erzeugen, wenn der aktive Verschluss einen kontrollCode
  // (Siegel-Nummer) hat — ohne Siegel gibt es nichts zu verifizieren.
  // Bei aktivem Siegel prüft die Verifikation die Siegel-Nummer zusätzlich (Server-seitig).
  const hasSeal = latest?.type === "VERSCHLUSS" && !!latest.kontrollCode;
  // URL-Code (von KontrollAnforderungs-E-Mail) hat immer Vorrang — er wurde bereits generiert und
  // versendet, unabhängig vom Siegel-Status.
  // Selbstkontrolle (kein URL-Code): Frische-Code nur erzeugen wenn ein Siegel vorhanden ist —
  // ohne Siegel gibt es nichts zu verifizieren, kein Code nötig.
  const effectiveCode = code ?? (hasSeal ? generateKontrollCode() : undefined);
  const sealRequired = sealRequiredForCode(effectiveCode, latest ?? null);
  const tn = await getTranslations("newEntry");
  const tf = await getTranslations("inspectionForm");
  const tdash = await getTranslations("dashboard");
  const deviceLabel = device === "PLUG" ? tdash("deviceLabelPlug") : device === "CAGE" ? tdash("deviceLabelCage") : null;
  return (
    <div className="w-full max-w-2xl mx-auto px-4 py-6">
      <Link href="/dashboard" className="text-sm text-foreground-faint hover:text-foreground-muted transition">{tn("back")}</Link>
      <h1 className="text-xl font-bold text-foreground mt-1 mb-6">
        {tf("title")}
        {deviceLabel && <span className="text-foreground-muted font-normal"> · {deviceLabel}</span>}
      </h1>
      <PruefungForm tz={tz} nowDefault={nowDatetimeLocal(tz)} initialCode={effectiveCode} initialKommentar={kommentar} sealRequired={sealRequired} mobileDesktopMode={dbUser?.mobileDesktopUpload ?? false} />
    </div>
  );
}
