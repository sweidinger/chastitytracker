"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import Toggle from "@/app/components/Toggle";

const inputCls = "w-16 border border-border rounded-lg px-2 py-1.5 text-sm text-foreground bg-surface-raised focus:outline-none focus:ring-2 focus:ring-foreground/20";

export default function PlugToggle({
  userId,
  initialReinigungErlaubt,
  initialReinigungMaxMinuten,
  initialReinigungMaxProTag,
  initialToiletteMaxMinuten,
}: {
  userId: string;
  initialReinigungErlaubt: boolean;
  initialReinigungMaxMinuten: number;
  initialReinigungMaxProTag: number;
  initialToiletteMaxMinuten: number;
}) {
  const t = useTranslations("admin");
  const router = useRouter();
  const [reinigungErlaubt, setReinigungErlaubt] = useState(initialReinigungErlaubt);
  const [reinigungMaxMin, setReinigungMaxMin] = useState(initialReinigungMaxMinuten);
  const [reinigungMaxProTag, setReinigungMaxProTag] = useState(initialReinigungMaxProTag);
  const [toiletteMaxMin, setToiletteMaxMin] = useState(initialToiletteMaxMinuten);
  const [saving, setSaving] = useState(false);

  async function save(patch: Record<string, unknown>) {
    setSaving(true);
    await fetch(`/api/admin/users/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    setSaving(false);
    router.refresh();
  }

  function saveAll(
    rErlaubt = reinigungErlaubt, rMin = reinigungMaxMin, rTag = reinigungMaxProTag,
    tMin = toiletteMaxMin,
  ) {
    save({
      plugReinigungErlaubt: rErlaubt, plugReinigungMaxMinuten: rMin, plugReinigungMaxProTag: rTag,
      plugToiletteMaxMinuten: tMin,
    });
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Reinigung */}
      <div className="flex flex-col gap-3">
        <Toggle
          label={t("plugReinigungLabel")}
          description={t("plugReinigungDesc")}
          checked={reinigungErlaubt}
          disabled={saving}
          onChange={(checked) => { setReinigungErlaubt(checked); saveAll(checked); }}
        />
        {reinigungErlaubt && (
          <>
            <div className="flex items-center gap-2 pl-1">
              <span className="text-xs text-foreground-faint">{t("reinigungMaxLabel")}</span>
              <input type="number" min={1} max={120} value={reinigungMaxMin}
                onChange={(e) => setReinigungMaxMin(Math.max(1, Math.min(120, Number(e.target.value) || 15)))}
                onBlur={() => saveAll()}
                disabled={saving} className={inputCls} />
              <span className="text-xs text-foreground-faint">min</span>
            </div>
            <div className="flex items-center gap-2 pl-1">
              <span className="text-xs text-foreground-faint">{t("reinigungMaxProTagLabel")}</span>
              <input type="number" min={0} max={20} value={reinigungMaxProTag}
                onChange={(e) => setReinigungMaxProTag(Math.max(0, Math.min(20, Number(e.target.value) || 0)))}
                onBlur={() => saveAll()}
                disabled={saving} className={inputCls} />
              <span className="text-xs text-foreground-faint">{t("reinigungMaxProTagHint")}</span>
            </div>
          </>
        )}
      </div>

      <div className="border-t border-border-subtle" />

      {/* Toilette — immer erlaubt, unbegrenzt; nur Max.-Dauer konfigurierbar */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-col min-h-[48px] justify-center">
          <span className="text-sm font-medium text-foreground">{t("plugToiletteLabel")}</span>
          <span className="text-xs text-foreground-faint">{t("plugToiletteAlwaysDesc")}</span>
        </div>
        <div className="flex items-center gap-2 pl-1">
          <span className="text-xs text-foreground-faint">{t("toiletteMaxLabel")}</span>
          <input type="number" min={1} max={120} value={toiletteMaxMin}
            onChange={(e) => setToiletteMaxMin(Math.max(1, Math.min(120, Number(e.target.value) || 15)))}
            onBlur={() => saveAll()}
            disabled={saving} className={inputCls} />
          <span className="text-xs text-foreground-faint">min</span>
        </div>
      </div>
    </div>
  );
}
