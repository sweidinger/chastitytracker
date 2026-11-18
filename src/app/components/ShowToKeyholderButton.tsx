"use client";

import { useRouter } from "next/navigation";
import { MessageCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { useKeyholderEnabled } from "./KeyholderEnabledContext";

/** „Der Keyholderin zeigen": legt einen Eintrag (mit Foto) einmalig der AI-Keyholderin im Chat vor.
 *  Erscheint nur, wenn die KI-Keyholderin für den Sub aktiv ist (Context, s. dashboard/layout). */
export default function ShowToKeyholderButton({ entryId }: { entryId: string }) {
  const enabled = useKeyholderEnabled();
  const router = useRouter();
  const t = useTranslations("common");
  if (!enabled) return null;

  const label = t("showToKeyholderMsg");
  const href = `/dashboard/keyholder?showEntry=${encodeURIComponent(entryId)}&label=${encodeURIComponent(label)}`;

  return (
    <button
      type="button"
      onClick={() => router.push(href)}
      className="inline-flex items-center gap-1.5 rounded-xl border border-accent/30 hover:border-accent/60 px-3 py-1.5 text-xs font-semibold text-accent transition-colors"
    >
      <MessageCircle size={14} />
      {t("showToKeyholder")}
    </button>
  );
}
