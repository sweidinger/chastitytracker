import { EntryActionFormShell } from "@/app/components/AdminActionFormShell";
import { actionSign } from "@/app/entries/actionSign";
import OrgasmusForm from "../../OrgasmusForm";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getTranslations } from "next-intl/server";
import { nowDatetimeLocal, APP_TZ } from "@/lib/utils";
import { effectiveOrgasmusArten, resolveOrgasmusOptions } from "@/lib/reasonsService";
import { getBelohnungState, BELOHNUNG_ART } from "@/lib/belohnung";

export default async function NewOrgasmusPage({ searchParams }: { searchParams: Promise<{ art?: string }> }) {
  const sp = await searchParams;
  const session = await auth();
  const tz = session!.user.timezone ?? APP_TZ;
  const tf = await getTranslations("orgasmForm");
  const user = await prisma.user.findUnique({
    where: { id: session!.user.id },
    select: { orgasmusArtenConfig: true, mobileDesktopUpload: true },
  });
  // Foto-Pflicht: verlangt eine offene Anforderung im aktuellen Fenster einen Nachweis?
  const now = new Date();
  const offeneAnforderung = await prisma.orgasmusAnforderung.findFirst({
    where: {
      userId: session!.user.id, fulfilledAt: null, withdrawnAt: null,
      beginsAt: { lte: now }, endsAt: { gte: now }, fotoPflicht: true,
    },
    select: { id: true },
  });
  // "Belohnung" nur anbieten, wenn tatsächlich ein Belohnungs-Fenster aktiv ist (sonst ausblenden).
  const belohnung = await getBelohnungState(session!.user.id);
  const rewardActive = belohnung.activeWindow !== null;
  const artOptions = resolveOrgasmusOptions(effectiveOrgasmusArten(user?.orgasmusArtenConfig), tf)
    .filter((o) => rewardActive || o.mainToken !== BELOHNUNG_ART);
  // Kommt der Nutzer über den „Orgasmus erfassen"-Button einer Anforderung (?art=…), wird die Art
  // festgesetzt — aber nur, wenn sie aktuell ueberhaupt angeboten wird (z.B. „Belohnung" nur bei
  // aktivem Fenster). Sonst normal frei wählbar.
  const lockedArt = sp.art && artOptions.some((o) => o.mainToken === sp.art) ? sp.art : undefined;

  return (
    <EntryActionFormShell {...actionSign("ORGASMUS")} title={tf("title")}>
      <OrgasmusForm
        artOptions={artOptions}
        tz={tz}
        nowDefault={nowDatetimeLocal(tz)}
        fotoPflicht={offeneAnforderung !== null}
        mobileDesktopMode={user?.mobileDesktopUpload ?? false}
        lockedArt={lockedArt}
      />
    </EntryActionFormShell>
  );
}
