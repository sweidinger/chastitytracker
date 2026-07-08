import { notFound, redirect } from "next/navigation";
import { assertKeyholderOrAdmin } from "@/lib/authGuards";
import { prisma } from "@/lib/prisma";
import { deviceCategoriesEnabled } from "@/lib/constants";
import { getActiveWearSessionForCategory, getUserTimezone } from "@/lib/queries";
import { nowDatetimeLocal } from "@/lib/utils";
import { KG_BUILTIN_SLUG } from "@/lib/deviceCategories";
import WearForm from "@/app/dashboard/WearForm";
import AdminActionFormShell from "@/app/components/AdminActionFormShell";
import { Circle } from "lucide-react";
import { getTranslations } from "next-intl/server";

export default async function AdminWearBeginPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ category?: string }>;
}) {
  if (!deviceCategoriesEnabled()) notFound();
  const { id: userId } = await params;
  await assertKeyholderOrAdmin(userId);
  const { category: categoryId } = await searchParams;
  if (!categoryId) redirect(`/admin/users/${userId}/aktionen`);

  const [t, tw, category, devices, active, tz] = await Promise.all([
    getTranslations("admin"),
    getTranslations("wearForm"),
    prisma.deviceCategory.findUnique({
      where: { id: categoryId },
      select: { id: true, userId: true, name: true, color: true, icon: true, isBuiltIn: true, slug: true, requirePhoto: true },
    }),
    prisma.device.findMany({
      where: { userId, categoryId, archivedAt: null },
      orderBy: [{ createdAt: "asc" }],
      select: { id: true, name: true },
    }),
    getActiveWearSessionForCategory(userId, categoryId),
    getUserTimezone(userId),
  ]);
  // Block KG (uses VERSCHLUSS/OEFFNEN, not WEAR_BEGIN/END); allow plug + user-defined.
  if (!category || category.userId !== userId) notFound();
  if (category.isBuiltIn && category.slug === KG_BUILTIN_SLUG) notFound();
  if (active) redirect(`/admin/users/${userId}/aktionen/wear-end?category=${categoryId}`);

  return (
    <AdminActionFormShell
      userId={userId}
      backLabel={t("aktionen")}
      icon={<Circle size={20} strokeWidth={2} />}
      iconBg="var(--background-subtle)"
      iconColor="var(--foreground)"
      title={tw("titleBegin")}
    >
      <WearForm
        kind="begin"
        category={{ id: category.id, name: category.name, color: category.color, icon: category.icon, requirePhoto: category.requirePhoto }}
        devices={devices}
        adminUserId={userId}
        redirectTo={`/admin/users/${userId}/aktionen`}
        tz={tz}
        nowDefault={nowDatetimeLocal(tz)}
      />
    </AdminActionFormShell>
  );
}
