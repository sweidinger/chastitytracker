import Link from "next/link";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { deviceCategoriesEnabled } from "@/lib/constants";
import { getActiveWearSessionForCategory, getActivePlugSperrzeit } from "@/lib/queries";
import { midnightInTZ, nowDatetimeLocal, APP_TZ } from "@/lib/utils";
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

  // ── Generic wear-end form for non-plug categories ──────────────────────────
  if (!category.isBuiltIn) {
    const tn = await getTranslations("newEntry");
    const t = await getTranslations("wearForm");
    return (
      <div className="w-full max-w-2xl mx-auto px-4 py-6">
        <Link href="/dashboard" className="text-sm text-foreground-faint hover:text-foreground-muted transition">{tn("back")}</Link>
        <h1 className="text-xl font-bold text-foreground mt-1 mb-6">{t("titleEnd")}</h1>
        <WearForm
          kind="end"
          category={{ id: category.id, name: category.name, color: category.color, icon: category.icon }}
          activeSession={{
            deviceId: active.deviceId,
            deviceName: active.deviceName,
            since: active.since.toISOString(),
          }}
          tz={tz}
          nowDefault={nowDatetimeLocal(tz)}
        />
      </div>
    );
  }

  // ── Anal-Plug built-in: full Öffnen-mirror form ───────────────────────────
  const dayStart = midnightInTZ(new Date(), tz);
  const plugCatId = plugCategoryId(userId);

  const [user, reinigungHeute, toiletteHeute, activePlugSperrzeit] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        plugReinigungErlaubt: true, plugReinigungMaxMinuten: true, plugReinigungMaxProTag: true,
        plugToiletteMaxMinuten: true,
        oeffnenGruendeConfig: true,
      },
    }),
    prisma.entry.count({
      where: { userId, type: "WEAR_END", oeffnenGrund: "REINIGUNG", startTime: { gte: dayStart }, device: { categoryId: plugCatId } },
    }),
    prisma.entry.count({
      where: { userId, type: "WEAR_END", oeffnenGrund: "TOILETTE", startTime: { gte: dayStart }, device: { categoryId: plugCatId } },
    }),
    getActivePlugSperrzeit(userId, plugCatId),
  ]);

  const tn = await getTranslations("newEntry");
  const tf = await getTranslations("openForm");
  const tw = await getTranslations("wearForm");
  const grundOptions = resolveReasonList(effectiveOeffnenGruende(user?.oeffnenGruendeConfig), "opening", tf);

  return (
    <div className="w-full max-w-2xl mx-auto px-4 py-6">
      <Link href="/dashboard" className="text-sm text-foreground-faint hover:text-foreground-muted transition">{tn("back")}</Link>
      <h1 className="text-xl font-bold text-foreground mt-1 mb-6">{category.name} – {tw("titleEnd")}</h1>
      <PlugEndForm
        grundOptions={grundOptions}
        tz={tz}
        nowDefault={nowDatetimeLocal(tz)}
        deviceId={active.deviceId}
        activeSession={{ since: active.since.toISOString(), deviceName: active.deviceName }}
        sperrzeit={activePlugSperrzeit ? {
          endetAt: activePlugSperrzeit.endetAt?.toISOString() ?? null,
          unbefristet: activePlugSperrzeit.endetAt === null,
          reinigungErlaubt: activePlugSperrzeit.reinigungErlaubt,
          toiletteErlaubt: activePlugSperrzeit.toiletteErlaubt,
        } : undefined}
        reinigung={{
          erlaubt: user?.plugReinigungErlaubt ?? false,
          maxMinuten: user?.plugReinigungMaxMinuten ?? 15,
          maxProTag: user?.plugReinigungMaxProTag ?? 0,
          heuteAnzahl: reinigungHeute,
        }}
        toilette={{
          erlaubt: true,
          maxMinuten: user?.plugToiletteMaxMinuten ?? 15,
          maxProTag: 0,
          heuteAnzahl: toiletteHeute,
        }}
      />
    </div>
  );
}
