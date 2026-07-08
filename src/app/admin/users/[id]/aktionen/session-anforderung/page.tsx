import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { assertKeyholderOrAdmin } from "@/lib/authGuards";
import SessionAnforderungForm from "./SessionAnforderungForm";

export default async function AdminSessionAnforderungPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await assertKeyholderOrAdmin(id);

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) redirect("/admin");

  const sessionCategories = await prisma.deviceCategory.findMany({
    where: { userId: id, isSessionCategory: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: {
      id: true, name: true, maxSessionMinutes: true, requiresVideo: true,
      devices: { where: { archivedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true } },
    },
  });

  if (sessionCategories.length === 0) {
    redirect(`/admin/users/${id}/aktionen`);
  }

  return (
    <SessionAnforderungForm
      userId={id}
      categories={sessionCategories}
    />
  );
}
