"use client";

import { useRouter } from "next/navigation";
import { Anchor } from "lucide-react";
import { useTranslations } from "next-intl";
import ActionModal from "@/app/components/ActionModal";
import PlugAnforderungFields from "@/app/admin/verschluss-anforderung/PlugAnforderungFields";
import type { DeviceOption } from "@/lib/queries";

export default function PlugAnforderungForm({
  userId,
  deviceCategoryId,
  art,
  devices = [],
  tz,
  minNow,
}: {
  userId: string;
  deviceCategoryId: string;
  art: "ANFORDERUNG" | "SPERRZEIT";
  devices?: DeviceOption[];
  tz: string;
  minNow: string;
}) {
  const t = useTranslations("admin");
  const router = useRouter();
  const isSperrzeit = art === "SPERRZEIT";
  const close = () => router.push(`/admin/users/${userId}/aktionen`);

  return (
    <ActionModal
      open={true}
      onClose={close}
      title={isSperrzeit ? t("setPlugWearDuration") : t("requestWearPlug")}
      icon={<Anchor size={20} strokeWidth={2} style={{ color: isSperrzeit ? "var(--color-sperrzeit)" : "var(--color-request)" }} />}
      iconBg={isSperrzeit ? "var(--color-sperrzeit-bg)" : "var(--color-request-bg)"}
    >
      <PlugAnforderungFields
        userId={userId}
        deviceCategoryId={deviceCategoryId}
        art={art}
        devices={devices}
        tz={tz}
        minNow={minNow}
        onSuccess={close}
      />
    </ActionModal>
  );
}
