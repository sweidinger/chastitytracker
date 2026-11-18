import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { assertKeyholderOrAdmin } from "@/lib/authGuards";
import { getActiveWearSessionForCategory, getActivePlugAnforderung, getActivePlugSperrzeit, getPlugDeviceOptions, getUserTimezone } from "@/lib/queries";
import { plugCategoryId } from "@/lib/deviceCategories";
import { nowDatetimeLocal } from "@/lib/utils";
import PlugAnforderungForm from "./PlugAnforderungForm";

export default async function AdminPlugAnforderungPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await assertKeyholderOrAdmin(id);

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) redirect("/admin");

  const catId = plugCategoryId(id);
  const [isWearing, offeneAnforderung, activeSperrzeit, tz, plugDevices] = await Promise.all([
    getActiveWearSessionForCategory(id, catId),
    getActivePlugAnforderung(id, catId),
    getActivePlugSperrzeit(id, catId),
    getUserTimezone(id),
    getPlugDeviceOptions(id, catId),
  ]);

  // Art bestimmen: ANFORDERUNG wenn nicht getragen, SPERRZEIT wenn aktiv getragen
  const art = isWearing ? "SPERRZEIT" : "ANFORDERUNG";

  // Kein Submit möglich wenn: bereits offene Anforderung (nicht getragen) oder aktive Sperrdauer (getragen)
  const canSubmit = art === "ANFORDERUNG"
    ? !offeneAnforderung
    : !activeSperrzeit;

  if (!canSubmit) {
    redirect(`/admin/users/${id}/aktionen`);
  }

  return (
    <PlugAnforderungForm
      userId={id}
      deviceCategoryId={catId}
      art={art}
      devices={plugDevices}
      tz={tz}
      minNow={nowDatetimeLocal(tz)}
    />
  );
}
