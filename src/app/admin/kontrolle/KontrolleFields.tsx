"use client";

import { useState } from "react";
import { Bell } from "lucide-react";
import { useTranslations } from "next-intl";
import FormError from "@/app/components/FormError";
import Button from "@/app/components/Button";
import Input from "@/app/components/Input";
import Textarea from "@/app/components/Textarea";
import Toggle from "@/app/components/Toggle";
import { parseApiErrorCode } from "@/lib/apiClient";
import { useApiError } from "@/app/hooks/useApiError";

/**
 * Shared form body for "Kontrolle anfordern".
 * Caller wraps this in an ActionModal and provides onSuccess.
 */
export default function KontrolleFields({
  userId,
  hasPlug,
  onSuccess,
}: {
  userId: string;
  hasPlug?: boolean;
  onSuccess: () => void;
}) {
  const t = useTranslations("admin");
  const tc = useTranslations("common");
  const [device, setDevice] = useState<"cage" | "plug">("cage");
  const isPlug = device === "plug";
  const apiError = useApiError();
  const [kommentar, setKommentar] = useState("");
  const [deadlineH, setDeadlineH] = useState("4");
  const [requireCode, setRequireCode] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // For plug: code is never required
  const effectiveRequireCode = isPlug ? false : requireCode;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/admin/kontrolle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          kommentar: kommentar.trim() || undefined,
          deadlineH: parseFloat(deadlineH) || 4,
          requireCode: effectiveRequireCode,
          device: device.toUpperCase() as "CAGE" | "PLUG",
        }),
      });
      if (res.ok) onSuccess();
      else setError(apiError(await parseApiErrorCode(res)));
    } catch {
      setError(tc("networkError"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">

      {/* Device selector — only shown when user has a plug */}
      {hasPlug && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium text-foreground-faint uppercase tracking-wide">{t("kontrolleDeviceLabel")}</p>
          <div className="flex gap-2">
            {(["cage", "plug"] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDevice(d)}
                className={`flex-1 py-2 px-3 rounded-xl text-sm font-medium border transition-colors ${
                  device === d
                    ? "bg-inspect text-white border-inspect"
                    : "bg-surface border-border-subtle text-foreground-muted hover:bg-surface-raised"
                }`}
              >
                {d === "cage" ? t("kontrolleDeviceCage") : t("kontrolleDevicePlug")}
              </button>
            ))}
          </div>
        </div>
      )}

      <Textarea
        label={t("kontrolleInstruction")}
        value={kommentar}
        onChange={(e) => setKommentar(e.target.value)}
        placeholder={isPlug ? t("kontrolleInstructionPlugPlaceholder") : t("kontrolleInstruction")}
        rows={2}
      />

      <div className="flex items-center gap-2">
        <label className="text-xs text-foreground-faint whitespace-nowrap">{t("kontrolleHours")}</label>
        <div className="w-24">
          <Input type="number" value={deadlineH} onChange={(e) => setDeadlineH(e.target.value)} min={0.1} step={0.1} />
        </div>
        <span className="text-xs text-foreground-faint">h</span>
      </div>

      {/* requireCode toggle: hidden for plug (always false) */}
      {!isPlug && (
        <Toggle
          label={t("kontrolleRequireCode")}
          checked={requireCode}
          onChange={setRequireCode}
        />
      )}

      <FormError message={error} variant="compact" />

      <Button type="submit" variant="primary" fullWidth loading={saving} icon={<Bell size={16} />}>
        {t("kontrolleRequest")}
      </Button>
    </form>
  );
}
