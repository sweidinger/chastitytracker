import { Dices } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { assertKeyholderOrAdmin } from "@/lib/authGuards";
import { listZufallsPools } from "@/lib/zufallService";
import AdminActionFormShell from "@/app/components/AdminActionFormShell";
import ZufallPoolEditor, { type EditorPool } from "./ZufallPoolEditor";

export default async function AdminZufallPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await assertKeyholderOrAdmin(id);
  const [pools, t] = await Promise.all([listZufallsPools(id), getTranslations("zufall")]);

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
      <ZufallPoolEditor userId={id} initialPools={initial} />
    </AdminActionFormShell>
  );
}
