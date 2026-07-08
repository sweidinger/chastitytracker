"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import useToast from "@/app/hooks/useToast";
import PlugEndFormCore from "@/app/entries/PlugEndFormCore";
import type { PlugEndPayload, ReinigungConfig, ToiletteConfig, SperrzeitState, SubmitResult } from "@/app/entries/types";
import type { ResolvedReason } from "@/lib/reasonsService";

interface Props {
  deviceId: string;
  activeSession: { since: string; deviceName: string };
  grundOptions: ResolvedReason[];
  tz: string;
  nowDefault: string;
  sperrzeit?: SperrzeitState;
  reinigung?: ReinigungConfig;
  toilette?: ToiletteConfig;
  redirectTo?: string;
}

export default function PlugEndForm({ deviceId, activeSession, grundOptions, tz, nowDefault, sperrzeit, reinigung, toilette, redirectTo }: Props) {
  const tCommon = useTranslations("common");
  const tDash = useTranslations("dashboard");
  const router = useRouter();
  const toast = useToast();
  const target = redirectTo ?? "/dashboard";

  async function submitFn(payload: PlugEndPayload): Promise<SubmitResult> {
    const res = await fetch("/api/entries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { ok: false, error: err.error || tCommon("savingError") };
    }
    toast.success(tDash("entrySaved"));
    return { ok: true };
  }

  function onSuccess() {
    window.location.href = target;
  }

  return (
    <PlugEndFormCore
      deviceId={deviceId}
      activeSession={activeSession}
      grundOptions={grundOptions}
      tz={tz}
      nowDefault={nowDefault}
      sperrzeit={sperrzeit}
      reinigung={reinigung}
      toilette={toilette}
      submitFn={submitFn}
      onSuccess={onSuccess}
      onCancel={() => router.push("/dashboard")}
    />
  );
}
