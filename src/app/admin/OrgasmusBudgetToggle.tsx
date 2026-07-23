"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import Toggle from "@/app/components/Toggle";

export default function OrgasmusBudgetToggle({
  userId,
  initialBudget,
  initialPeriode,
}: {
  userId: string;
  initialBudget: number | null;
  initialPeriode: string;
}) {
  const t = useTranslations("admin");
  const router = useRouter();
  const [aktiv, setAktiv] = useState(initialBudget != null);
  const [budget, setBudget] = useState(initialBudget ?? 1);
  const [periode, setPeriode] = useState(initialPeriode === "MONAT" ? "MONAT" : "WOCHE");
  const [saving, setSaving] = useState(false);

  async function save(body: Record<string, unknown>) {
    setSaving(true);
    await fetch(`/api/admin/users/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaving(false);
    router.refresh();
  }

  function handleToggle(checked: boolean) {
    setAktiv(checked);
    save(checked ? { orgasmBudget: budget, orgasmBudgetPeriode: periode } : { orgasmBudget: null });
  }

  function handleBudget(e: React.ChangeEvent<HTMLInputElement>) {
    setBudget(Math.max(0, Math.min(99, Number(e.target.value) || 0)));
  }

  function handlePeriode(e: React.ChangeEvent<HTMLSelectElement>) {
    const p = e.target.value === "MONAT" ? "MONAT" : "WOCHE";
    setPeriode(p);
    if (aktiv) save({ orgasmBudget: budget, orgasmBudgetPeriode: p });
  }

  const inputCls = "w-16 border border-border rounded-lg px-2 py-1.5 text-sm text-foreground bg-surface-raised focus:outline-none focus:ring-2 focus:ring-foreground/20";
  const selectCls = "border border-border rounded-lg px-2 py-1.5 text-sm text-foreground bg-surface-raised focus:outline-none focus:ring-2 focus:ring-foreground/20";

  return (
    <div className="flex flex-col gap-3">
      <Toggle
        label={t("orgasmBudgetActiveLabel")}
        description={t("orgasmBudgetActiveDesc")}
        checked={aktiv}
        disabled={saving}
        onChange={handleToggle}
      />
      {aktiv && (
        <>
          <div className="flex items-center gap-2 pl-1">
            <span className="text-xs text-foreground-faint">{t("orgasmBudgetMaxLabel")}</span>
            <input
              type="number"
              min={0}
              max={99}
              value={budget}
              onChange={handleBudget}
              onBlur={() => save({ orgasmBudget: budget, orgasmBudgetPeriode: periode })}
              disabled={saving}
              className={inputCls}
            />
          </div>
          <div className="flex items-center gap-2 pl-1">
            <span className="text-xs text-foreground-faint">{t("orgasmBudgetPeriodeLabel")}</span>
            <select value={periode} onChange={handlePeriode} disabled={saving} className={selectCls}>
              <option value="WOCHE">{t("orgasmBudgetPeriodeWoche")}</option>
              <option value="MONAT">{t("orgasmBudgetPeriodeMonat")}</option>
            </select>
          </div>
        </>
      )}
    </div>
  );
}
