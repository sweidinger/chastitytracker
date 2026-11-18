import { EntryActionFormShell } from "@/app/components/AdminActionFormShell";
import { actionSign } from "@/app/entries/actionSign";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { deviceCategoriesEnabled } from "@/lib/constants";
import { getActiveSessionForCategory, getActiveSessionAnforderung } from "@/lib/sessionService";
import { nowDatetimeLocal, APP_TZ } from "@/lib/utils";
import SessionForm from "../../SessionForm";

export default async function NewSessionEndPage({ searchParams }: { searchParams: Promise<{ category?: string }> }) {
  if (!deviceCategoriesEnabled()) notFound();
  const session = await auth();
  if (!session) redirect("/login");
  const tz = session.user.timezone ?? APP_TZ;

  const { category: categoryId } = await searchParams;
  if (!categoryId) redirect("/dashboard/categories");

  const category = await prisma.deviceCategory.findUnique({
    where: { id: categoryId },
    select: { id: true, userId: true, name: true, color: true, icon: true, isSessionCategory: true, maxSessionMinutes: true, requiresVideo: true, orgasmusZiel: true },
  });
  if (!category || category.userId !== session.user.id || !category.isSessionCategory) notFound();

  // No active session → redirect to begin form
  const active = await getActiveSessionForCategory(session.user.id, categoryId);
  if (!active) redirect(`/dashboard/new/session-begin?category=${categoryId}`);

  // Load the device for the active session
  const device = active.deviceId
    ? await prisma.device.findUnique({ where: { id: active.deviceId }, select: { id: true, name: true } })
    : null;

  // Offene Session-Anforderung (Admin/AI) überschreibt Video-Pflicht + Orgasmus-Ziel der Kategorie.
  const anforderung = await getActiveSessionAnforderung(session.user.id, categoryId);
  const effRequiresVideo = anforderung ? anforderung.requireVideo : category.requiresVideo;
  const effOrgasmusZiel = anforderung ? anforderung.orgasmusZiel : category.orgasmusZiel;
  const effOrgasmusRuiniert = anforderung ? anforderung.orgasmusRuiniert : false;

  const t = await getTranslations("sessionForm");

  return (
    <EntryActionFormShell {...actionSign("WEAR_END")} title={t("titleEnd")}>
      <SessionForm
        kind="end"
        category={{ id: category.id, name: category.name, color: category.color, icon: category.icon, maxSessionMinutes: category.maxSessionMinutes, requiresVideo: effRequiresVideo, orgasmusZiel: effOrgasmusZiel, orgasmusRuiniert: effOrgasmusRuiniert }}
        activeSession={{
          beginEntryId: active.id,
          deviceId: active.deviceId ?? "",
          deviceName: device?.name ?? "",
          since: active.startTime.toISOString(),
        }}
        tz={tz}
        nowDefault={nowDatetimeLocal(tz)}
      />
    </EntryActionFormShell>
  );
}
