import Link from "next/link";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { deviceCategoriesEnabled } from "@/lib/constants";
import { getActiveWearSessionForCategory } from "@/lib/queries";
import { nowDatetimeLocal, APP_TZ } from "@/lib/utils";
import WearForm from "../../WearForm";

export default async function NewWearBeginPage({ searchParams }: { searchParams: Promise<{ category?: string; anforderung?: string }> }) {
  if (!deviceCategoriesEnabled()) notFound();
  const session = await auth();
  if (!session) redirect("/login");
  const tz = session.user.timezone ?? APP_TZ;

  const { category: categoryId, anforderung: anforderungId } = await searchParams;
  if (!categoryId) redirect("/dashboard/categories");

  const category = await prisma.deviceCategory.findUnique({
    where: { id: categoryId },
    select: { id: true, userId: true, name: true, color: true, icon: true, isBuiltIn: true, slug: true, requirePhoto: true },
  });
  // Block KG (uses VERSCHLUSS/OEFFNEN, not WEAR_BEGIN/END); allow plug + user-defined.
  if (!category || category.userId !== session.user.id) notFound();
  if (category.isBuiltIn && category.slug !== "plug") notFound();

  // Block if a session is already active in this category
  const active = await getActiveWearSessionForCategory(session.user.id, categoryId);
  if (active) redirect(`/dashboard/new/wear-end?category=${categoryId}`);

  const devices = await prisma.device.findMany({
    where: { userId: session.user.id, categoryId, archivedAt: null },
    orderBy: [{ createdAt: "asc" }],
    select: { id: true, name: true },
  });

  const tn = await getTranslations("newEntry");
  const t = await getTranslations("wearForm");

  // Aus einer Wear-Anforderung geoeffnet: Geraet fest vorwaehlen + sperren, Foto-Pflicht ggf. ueberschreiben.
  let forcedDeviceId: string | null = null;
  let requirePhoto = category.requirePhoto;
  if (anforderungId) {
    const anf = await prisma.verschlussAnforderung.findFirst({
      where: { id: anforderungId, userId: session.user.id, deviceCategoryId: categoryId, art: "ANFORDERUNG", fulfilledAt: null, withdrawnAt: null },
      select: { deviceId: true, fotoPflicht: true },
    });
    if (anf) {
      forcedDeviceId = anf.deviceId;
      if (anf.fotoPflicht !== null) requirePhoto = anf.fotoPflicht;
    }
  }

  if (devices.length === 0) {
    return (
      <div className="w-full max-w-2xl mx-auto px-4 py-6">
        <Link href="/dashboard" className="text-sm text-foreground-faint hover:text-foreground-muted transition">{tn("back")}</Link>
        <div className="mt-4 p-6 rounded-xl border border-border bg-surface text-center">
          <p className="text-sm text-foreground-muted mb-3">{t("noDevicesInCategory", { name: category.name })}</p>
          <Link href="/dashboard/geraete" className="text-sm font-medium text-foreground underline">
            {t("addDeviceLink")}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-2xl mx-auto px-4 py-6">
      <Link href="/dashboard" className="text-sm text-foreground-faint hover:text-foreground-muted transition">{tn("back")}</Link>
      <h1 className="text-xl font-bold text-foreground mt-1 mb-6">{t("titleBegin")}</h1>
      <WearForm
        kind="begin"
        category={{ id: category.id, name: category.name, color: category.color, icon: category.icon, requirePhoto }}
        devices={devices}
        forcedDeviceId={forcedDeviceId}
        tz={tz}
        nowDefault={nowDatetimeLocal(tz)}
      />
    </div>
  );
}
