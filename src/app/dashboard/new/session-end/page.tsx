import Link from "next/link";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { deviceCategoriesEnabled } from "@/lib/constants";
import { getActiveSessionForCategory } from "@/lib/sessionService";
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

  const tn = await getTranslations("newEntry");
  const t = await getTranslations("sessionForm");

  return (
    <div className="w-full max-w-2xl mx-auto px-4 py-6">
      <Link href="/dashboard" className="text-sm text-foreground-faint hover:text-foreground-muted transition">{tn("back")}</Link>
      <h1 className="text-xl font-bold text-foreground mt-1 mb-6">{t("titleEnd")}</h1>
      <SessionForm
        kind="end"
        category={{ id: category.id, name: category.name, color: category.color, icon: category.icon, maxSessionMinutes: category.maxSessionMinutes, requiresVideo: category.requiresVideo, orgasmusZiel: category.orgasmusZiel }}
        activeSession={{
          beginEntryId: active.id,
          deviceId: active.deviceId ?? "",
          deviceName: device?.name ?? "",
          since: active.startTime.toISOString(),
        }}
        tz={tz}
        nowDefault={nowDatetimeLocal(tz)}
      />
    </div>
  );
}
