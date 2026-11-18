import { EntryActionFormShell } from "@/app/components/AdminActionFormShell";
import { actionSign } from "@/app/entries/actionSign";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { deviceCategoriesEnabled } from "@/lib/constants";
import { getActiveWearSessionForCategory, getActivePlugSperrzeit } from "@/lib/queries";
import { nowDatetimeLocal, APP_TZ } from "@/lib/utils";
import { getTasksBlocking } from "@/lib/taskIntervals";
import { plugCategoryId, PLUG_BUILTIN_SLUG } from "@/lib/deviceCategories";
import { effectiveOeffnenGruende, resolveReasonList } from "@/lib/reasonsService";
import WearForm from "../../WearForm";
import PlugEndForm from "../../PlugEndForm";

export default async function NewWearEndPage({ searchParams }: { searchParams: Promise<{ category?: string }> }) {
  if (!deviceCategoriesEnabled()) notFound();
  const session = await auth();
  if (!session) redirect("/login");
  const tz = session.user.timezone ?? APP_TZ;
  const userId = session.user.id;

  const { category: categoryId } = await searchParams;
  if (!categoryId) redirect("/dashboard/categories");

  const category = await prisma.deviceCategory.findUnique({
    where: { id: categoryId },
    select: { id: true, userId: true, name: true, color: true, icon: true, isBuiltIn: true, slug: true },
  });
  // Block other built-in categories (KG uses OEFFNEN, not WEAR_END); allow plug.
  if (!category || category.userId !== userId) notFound();
  if (category.isBuiltIn && category.slug !== PLUG_BUILTIN_SLUG) notFound();

  const active = await getActiveWearSessionForCategory(userId, categoryId);
  // No active session → redirect to begin form
  if (!active) redirect(`/dashboard/new/wear-begin?category=${categoryId}`);
  const t = await getTranslations("wearForm");
  // Warnung VOR dem Ablegen: ohne sie wären es zwei Taps von „Aufgabe läuft" zu „Vergehen".
  const taskWarnings = await getTasksBlocking(userId, new Date(), {
    categoryId,
    deviceId: active.deviceId,
  });

  // ── Generische Trage-Ende-Form für Nicht-Plug-Kategorien ──────────────────
  if (!category.isBuiltIn) {
    return (
      <EntryActionFormShell {...actionSign("WEAR_END")} title={t("titleEnd")}>
        <WearForm
          kind="end"
          category={{ id: category.id, name: category.name, color: category.color, icon: category.icon }}
          activeSession={{
            deviceId: active.deviceId,
            deviceName: active.deviceName,
            since: active.since.toISOString(),
          }}
          taskWarnings={taskWarnings}
          tz={tz}
          nowDefault={nowDatetimeLocal(tz)}
        />
      </EntryActionFormShell>
    );
  }

  // ── Anal-Plug built-in (Fork): vollständige Öffnen-Spiegel-Form ──────────
  // Reinigung/Toilette laufen über die Pause-Funktion — das Formular braucht nur Gründe + Sperrzeit.
  const [user, activePlugLockPeriod] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { oeffnenGruendeConfig: true } }),
    getActivePlugSperrzeit(userId, plugCategoryId(userId)),
  ]);

  const tf = await getTranslations("openForm");
  // Reinigung/Toilette laufen ausschließlich über die Pause-Funktion → hier nicht als Grund anbieten.
  const grundOptions = resolveReasonList(
    effectiveOeffnenGruende(user?.oeffnenGruendeConfig).filter((r) => r.code !== "REINIGUNG" && r.code !== "TOILETTE"),
    "opening", tf,
  );

  return (
    <EntryActionFormShell {...actionSign("WEAR_END")} title={`${category.name} – ${t("titleEnd")}`}>
      <PlugEndForm
        grundOptions={grundOptions}
        tz={tz}
        nowDefault={nowDatetimeLocal(tz)}
        deviceId={active.deviceId}
        activeSession={{ since: active.since.toISOString(), deviceName: active.deviceName }}
        lockPeriod={activePlugLockPeriod ? {
          endsAt: activePlugLockPeriod.endsAt?.toISOString() ?? null,
          indefinite: activePlugLockPeriod.endsAt === null,
          cleaningAllowed: activePlugLockPeriod.cleaningAllowed,
          toiletteErlaubt: activePlugLockPeriod.toiletteErlaubt,
        } : undefined}
      />
    </EntryActionFormShell>
  );
}
