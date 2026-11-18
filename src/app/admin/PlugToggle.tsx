"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Plus, X } from "lucide-react";
import Toggle from "@/app/components/Toggle";

const inputCls = "w-16 border border-border rounded-lg px-2 py-1.5 text-sm text-foreground bg-surface-raised focus:outline-none focus:ring-2 focus:ring-foreground/20";

type Fenster = { start: string; end: string };

export default function PlugToggle({
  userId,
  initialReinigungErlaubt,
  initialReinigungMaxMinuten,
  initialReinigungMaxProTag,
  initialReinigungsFenster,
  initialToiletteMaxMinuten,
}: {
  userId: string;
  initialReinigungErlaubt: boolean;
  initialReinigungMaxMinuten: number;
  initialReinigungMaxProTag: number;
  initialReinigungsFenster: Fenster[];
  initialToiletteMaxMinuten: number;
}) {
  const t = useTranslations("admin");
  const router = useRouter();
  const [reinigungErlaubt, setReinigungErlaubt] = useState(initialReinigungErlaubt);
  const [reinigungMaxMin, setReinigungMaxMin] = useState(initialReinigungMaxMinuten);
  const [reinigungMaxProTag, setReinigungMaxProTag] = useState(initialReinigungMaxProTag);
  const [fenster, setFenster] = useState<Fenster[]>(initialReinigungsFenster);
  const [toiletteMaxMin, setToiletteMaxMin] = useState(initialToiletteMaxMinuten);
  const [saving, setSaving] = useState(false);

  async function saveFenster(next: Fenster[]) {
    setFenster(next);
    setSaving(true);
    await fetch(`/api/admin/users/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plugReinigungsFenster: next.filter((f) => f.start && f.end && f.start < f.end) }),
    });
    setSaving(false);
    router.refresh();
  }

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
            {/* Reinigungs-Fenster (täglich) — analog Cage */}
            <div className="flex flex-col gap-2 pl-1">
              <span className="text-xs text-foreground-faint">{t("reinigungFensterLabel")}</span>
              {fenster.length === 0 && (
                <span className="text-xs text-foreground-faint italic">{t("reinigungFensterEmpty")}</span>
              )}
              {fenster.map((f, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input type="time" value={f.start} disabled={saving}
                    onChange={(e) => saveFenster(fenster.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))}
                    className={inputCls} />
                  <span className="text-xs text-foreground-faint">–</span>
                  <input type="time" value={f.end} disabled={saving}
                    onChange={(e) => saveFenster(fenster.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))}
                    className={inputCls} />
                  <button type="button" onClick={() => saveFenster(fenster.filter((_, j) => j !== i))}
                    disabled={saving} aria-label={t("reinigungFensterRemove")}
                    className="p-1 text-foreground-faint hover:text-foreground disabled:opacity-50">
                    <X size={16} />
                  </button>
                </div>
              ))}
              <button type="button" onClick={() => saveFenster([...fenster, { start: "19:00", end: "20:00" }])}
                disabled={saving}
                className="flex items-center gap-1 text-xs text-foreground-muted hover:text-foreground disabled:opacity-50 w-fit">
                <Plus size={14} /> {t("reinigungFensterAdd")}
              </button>
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
