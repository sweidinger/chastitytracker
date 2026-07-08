import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { assertKeyholderOrAdmin } from "@/lib/authGuards";
import { getIsLocked } from "@/lib/queries";
import KontrolleForm from "./KontrolleForm";

export default async function AdminKontrollePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ plug?: string }> }) {
  const { id } = await params;
  const { plug } = await searchParams;
  await assertKeyholderOrAdmin(id);

  const [user, isLocked] = await Promise.all([
    prisma.user.findUnique({ where: { id } }),
    getIsLocked(id),
  ]);
  if (!user) redirect("/admin");
  if (!user.email || !isLocked) redirect(`/admin/users/${id}/aktionen`);

  return <KontrolleForm userId={id} hasPlug={plug === "1"} />;
}
