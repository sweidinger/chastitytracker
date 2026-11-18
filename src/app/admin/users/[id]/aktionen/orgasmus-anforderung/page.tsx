import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { assertKeyholderOrAdmin } from "@/lib/authGuards";
import { getUserTimezone } from "@/lib/queries";
import { nowDatetimeLocal } from "@/lib/utils";
import OrgasmusAnforderungForm from "./OrgasmusAnforderungForm";

export default async function AdminOrgasmusAnforderungPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await assertKeyholderOrAdmin(id);

  // The directive sets times FOR the sub → the sub's tz governs the datetime-local defaults + submit.
  // Fork: die Art kommt aus kuratierten Presets im Formular, nicht aus der Art-Liste des Subs.
  const [user, tz] = await Promise.all([
    prisma.user.findUnique({ where: { id }, select: { id: true } }),
    getUserTimezone(id),
  ]);
  if (!user) redirect("/admin");

  return <OrgasmusAnforderungForm userId={id} tz={tz} nowDefault={nowDatetimeLocal(tz)} />;
}
