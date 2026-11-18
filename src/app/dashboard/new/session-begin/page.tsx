import Link from "next/link";
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

export default async function NewSessionBeginPage({ searchParams }: { searchParams: Promise<{ category?: string }> }) {
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

  // Redirect to session-end if already active
  const active = await getActiveSessionForCategory(session.user.id, categoryId);
  if (active) redirect(`/dashboard/new/session-end?category=${categoryId}`);

  const devices = await prisma.device.findMany({
    where: { userId: session.user.id, categoryId, archivedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });

  // Offene Session-Anforderung (Admin/AI) überschreibt Video-Pflicht + Orgasmus-Ziel der Kategorie.
  const anforderung = await getActiveSessionAnforderung(session.user.id, categoryId);
  const effRequiresVideo = anforderung ? anforderung.requireVideo : category.requiresVideo;
  const effOrgasmusZiel = anforderung ? anforderung.orgasmusZiel : category.orgasmusZiel;
  const effOrgasmusRuiniert = anforderung ? anforderung.orgasmusRuiniert : false;

  const t = await getTranslations("sessionForm");

  if (devices.length === 0) {
    return (
      <EntryActionFormShell {...actionSign("WEAR_BEGIN")} title={t("titleBegin")}>
        <div className="p-6 rounded-xl border border-border bg-surface text-center">
          <p className="text-sm text-foreground-muted mb-3">{t("noDevices", { name: category.name })}</p>
          <Link href="/dashboard/geraete" className="text-sm font-medium text-foreground underline">
            {t("addDevice")}
          </Link>
        </div>
      </EntryActionFormShell>
    );
  }

  return (
    <EntryActionFormShell {...actionSign("WEAR_BEGIN")} title={t("titleBegin")}>
      <SessionForm
        kind="begin"
        category={{ id: category.id, name: category.name, color: category.color, icon: category.icon, maxSessionMinutes: category.maxSessionMinutes, requiresVideo: effRequiresVideo, orgasmusZiel: effOrgasmusZiel, orgasmusRuiniert: effOrgasmusRuiniert }}
        devices={devices}
        tz={tz}
        nowDefault={nowDatetimeLocal(tz)}
      />
    </EntryActionFormShell>
  );
}
