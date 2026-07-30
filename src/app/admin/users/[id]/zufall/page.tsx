import { Dices } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { prisma } from "@/lib/prisma";
import { assertKeyholderOrAdmin } from "@/lib/authGuards";
import { listZufallsPools } from "@/lib/zufallService";
import AdminActionFormShell from "@/app/components/AdminActionFormShell";
import ZufallPoolEditor, { type EditorPool, type SessionCategory } from "./ZufallPoolEditor";

export default async function AdminZufallPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await assertKeyholderOrAdmin(id);
  const [pools, sessionCats, t] = await Promise.all([
    listZufallsPools(id),
    prisma.deviceCategory.findMany({
      where: { userId: id, isSessionCategory: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true, name: true, maxSessionMinutes: true, requiresVideo: true, orgasmusZiel: true,
        devices: { where: { archivedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true } },
      },
    }),
    getTranslations("zufall"),
  ]);

  const categories: SessionCategory[] = sessionCats.map((c) => ({
    id: c.id,
    name: c.name,
    maxSessionMinutes: c.maxSessionMinutes,
    requiresVideo: c.requiresVideo,
    orgasmusZiel: c.orgasmusZiel,
    devices: c.devices.map((d) => ({ id: d.id, name: d.name })),
  }));

  const initial: EditorPool[] = pools.map((p) => ({
    id: p.id,
    name: p.name,
    aktiv: p.aktiv,
    cooldownMin: p.cooldownMin ?? 0,
    maxAddH: p.maxAddH ?? 0,
    options: p.options.map((o) => ({
      id: o.id,
      label: o.label,
      weight: o.weight,
      outcomeType: o.outcomeType,
      outcomeJson: o.outcomeJson,
    })),
  }));

  return (
    <AdminActionFormShell
      userId={id}
      backLabel={t("back")}
      icon={<Dices size={20} />}
      iconBg="var(--color-sperrzeit-bg)"
      iconColor="var(--color-sperrzeit)"
      title={t("adminTitle")}
    >
      <ZufallPoolEditor userId={id} initialPools={initial} categories={categories} />
    </AdminActionFormShell>
  );
}
