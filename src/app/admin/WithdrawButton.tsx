"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import FormError from "@/app/components/FormError";

interface Props {
  id: string;
  /** API base path, e.g. "/api/admin/kontrollen" */
  apiPath: string;
  /** i18n key within "admin" namespace for the button title (Fork-Aufrufer). */
  titleKey?: string;
  /** Bereits übersetzte Beschriftung (Tasks #39, tasks-Namespace). Hat Vorrang vor titleKey. */
  title?: string;
  /** Beschriftung auch anzeigen statt nur als Tooltip (dichte Zeile: nur Kreuz; Karte: mit Wort). */
  showLabel?: boolean;
  /** Semantic color token, e.g. "inspect" or "sperrzeit" */
  colorToken: "inspect" | "sperrzeit" | "orgasm" | "neutral";
}

const colorClasses: Record<Props["colorToken"], string> = {
  inspect:   "text-[var(--color-inspect)] hover:bg-[var(--color-inspect-bg)]",
  sperrzeit: "text-[var(--color-sperrzeit)] hover:bg-[var(--color-sperrzeit-bg)]",
  orgasm:    "text-[var(--color-orgasm)] hover:bg-[var(--color-orgasm-bg)]",
  neutral:   "text-foreground-muted hover:bg-surface-raised",
};

export default function WithdrawButton({ id, apiPath, titleKey, title, showLabel, colorToken }: Props) {
  const t = useTranslations("admin");
  const tc = useTranslations("common");
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const label = title ?? (titleKey ? t(titleKey) : "");

  async function handle() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`${apiPath}/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "withdraw" }),
      });
      if (!res.ok) throw new Error(tc("savingError"));
      router.refresh();
    } catch {
      setError(tc("networkError"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        onClick={handle}
        disabled={saving}
        title={label}
        className={`flex items-center rounded-full active:scale-90 disabled:opacity-50 transition ${
          showLabel ? "gap-1.5 min-h-12 px-3 text-sm font-medium" : "p-1.5 -m-1"
        } ${colorClasses[colorToken]}`}
      >
        <X size={16} strokeWidth={2.5} />
        {showLabel && <span>{label}</span>}
      </button>
      <FormError message={error} />
    </>
  );
}
