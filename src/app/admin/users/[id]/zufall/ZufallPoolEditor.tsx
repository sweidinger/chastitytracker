"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Plus, Trash2, ChevronUp, ChevronDown } from "lucide-react";
import Card from "@/app/components/Card";
import Button from "@/app/components/Button";
import Input from "@/app/components/Input";
import Select from "@/app/components/Select";
import Toggle from "@/app/components/Toggle";
import NumberInput from "@/app/components/NumberInput";
import InlineSettingRow from "@/app/components/InlineSettingRow";
import { hapticMedium } from "@/lib/haptics";
import {
  ZUFALL_OUTCOME_TYPES, ZUFALL_WEIGHT_RANGE, ZUFALL_COOLDOWN_MIN_RANGE, ZUFALL_MAXADD_H_RANGE,
} from "@/lib/constants";

// ── Serialisierbare Editor-Formen ─────────────────────────────────────────────
export interface EditorOption {
  id: string;
  label: string;
  weight: number;
  outcomeType: string;
  outcomeJson: string | null;
}
export interface EditorPool {
  id: string;
  name: string;
  aktiv: boolean;
  cooldownMin: number;
  maxAddH: number;
  options: EditorOption[];
}

/** Lokaler Bearbeitungs-Stand einer Option — die typspezifischen Parameter als Strings, damit die
 *  Eingabefelder frei bearbeitbar bleiben; beim Speichern werden sie zu outcomeJson serialisiert. */
interface DraftOption {
  key: string;
  label: string;
  weight: number;
  outcomeType: string;
  hours: string;
  windowHours: string;
  text: string;
  dueH: string;
  ruined: boolean;
}
interface DraftPool {
  id: string;
  name: string;
  aktiv: boolean;
  cooldownMin: number;
  maxAddH: number;
  options: DraftOption[];
  saving: boolean;
  saved: boolean;
}

let keySeq = 0;
const nextKey = () => `opt-${keySeq++}`;

function toDraftOption(o: EditorOption): DraftOption {
  let p: Record<string, unknown> = {};
  if (o.outcomeJson) { try { p = JSON.parse(o.outcomeJson) ?? {}; } catch { p = {}; } }
  const s = (v: unknown) => (typeof v === "number" || typeof v === "string" ? String(v) : "");
  return {
    key: nextKey(),
    label: o.label,
    weight: o.weight,
    outcomeType: o.outcomeType,
    hours: s(p.hours),
    windowHours: s(p.windowHours),
    text: typeof p.text === "string" ? p.text : "",
    dueH: s(p.dueH),
    ruined: !!p.ruined,
  };
}
function toDraftPool(p: EditorPool): DraftPool {
  return { id: p.id, name: p.name, aktiv: p.aktiv, cooldownMin: p.cooldownMin, maxAddH: p.maxAddH, options: p.options.map(toDraftOption), saving: false, saved: false };
}

/** Baut outcomeJson aus den Draft-Parametern je Typ (spiegelt validateOptions im Service). */
function buildOutcomeJson(o: DraftOption): string | null {
  const p: Record<string, unknown> = {};
  switch (o.outcomeType) {
    case "TIME_ADD":
    case "TIME_SUB":
      p.hours = Number(o.hours) || 0;
      break;
    case "ORGASM_DIRECTIVE":
      p.windowHours = Number(o.windowHours) || 24;
      if (o.ruined) p.ruined = true;
      break;
    case "REWARD":
      if (o.windowHours) p.windowHours = Number(o.windowHours);
      break;
    case "PENALTY":
      if (o.text.trim()) p.text = o.text.trim();
      break;
    case "TASK":
      p.text = o.text.trim();
      if (o.dueH) p.dueH = Number(o.dueH);
      break;
    case "NOTHING":
    default:
      return null;
  }
  return Object.keys(p).length ? JSON.stringify(p) : null;
}

const emptyOption = (): DraftOption => ({ key: nextKey(), label: "", weight: ZUFALL_WEIGHT_RANGE.fallback, outcomeType: "NOTHING", hours: "", windowHours: "", text: "", dueH: "", ruined: false });

const OUTCOME_OPTIONS = (t: (k: string) => string) =>
  ZUFALL_OUTCOME_TYPES.map((v) => ({ value: v, label: t(`outcomes.${v}`) }));

export default function ZufallPoolEditor({ userId, initialPools }: { userId: string; initialPools: EditorPool[] }) {
  const t = useTranslations("zufall");
  const [pools, setPools] = useState<DraftPool[]>(initialPools.map(toDraftPool));
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  function patchPool(id: string, fn: (p: DraftPool) => DraftPool) {
    setPools((ps) => ps.map((p) => (p.id === id ? fn(p) : p)));
  }

  async function createPool() {
    if (!newName.trim() || creating) return;
    setCreating(true);
    setError("");
    try {
      const res = await fetch("/api/admin/zufall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, name: newName.trim() }),
      });
      if (!res.ok) { setError(t("error")); return; }
      const { id } = await res.json();
      setPools((ps) => [{ id, name: newName.trim(), aktiv: true, cooldownMin: 0, maxAddH: 0, options: [], saving: false, saved: false }, ...ps]);
      setNewName("");
    } catch {
      setError(t("error"));
    } finally {
      setCreating(false);
    }
  }

  async function savePool(pool: DraftPool) {
    patchPool(pool.id, (p) => ({ ...p, saving: true, saved: false }));
    setError("");
    try {
      const res = await fetch("/api/admin/zufall", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: pool.id,
          name: pool.name,
          aktiv: pool.aktiv,
          cooldownMin: pool.cooldownMin,
          maxAddH: pool.maxAddH,
          options: pool.options.map((o, i) => ({
            label: o.label.trim(),
            weight: o.weight,
            outcomeType: o.outcomeType,
            outcomeJson: buildOutcomeJson(o),
            sort: i,
          })),
        }),
      });
      if (!res.ok) { setError(t("error")); patchPool(pool.id, (p) => ({ ...p, saving: false })); return; }
      hapticMedium();
      patchPool(pool.id, (p) => ({ ...p, saving: false, saved: true }));
    } catch {
      setError(t("error"));
      patchPool(pool.id, (p) => ({ ...p, saving: false }));
    }
  }

  async function deletePool(id: string) {
    if (!confirm(t("deletePoolConfirm"))) return;
    setError("");
    try {
      const res = await fetch(`/api/admin/zufall?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) { setError(t("error")); return; }
      setPools((ps) => ps.filter((p) => p.id !== id));
    } catch {
      setError(t("error"));
    }
  }

  function updateOption(poolId: string, key: string, patch: Partial<DraftOption>) {
    patchPool(poolId, (p) => ({ ...p, saved: false, options: p.options.map((o) => (o.key === key ? { ...o, ...patch } : o)) }));
  }
  function addOption(poolId: string) {
    patchPool(poolId, (p) => ({ ...p, saved: false, options: [...p.options, emptyOption()] }));
  }
  function removeOption(poolId: string, key: string) {
    patchPool(poolId, (p) => ({ ...p, saved: false, options: p.options.filter((o) => o.key !== key) }));
  }
  function moveOption(poolId: string, index: number, dir: -1 | 1) {
    patchPool(poolId, (p) => {
      const next = [...p.options];
      const j = index + dir;
      if (j < 0 || j >= next.length) return p;
      [next[index], next[j]] = [next[j], next[index]];
      return { ...p, saved: false, options: next };
    });
  }

  const outcomeOptions = OUTCOME_OPTIONS(t);

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-foreground-faint">{t("adminIntro")}</p>

      {/* Neuen Pool anlegen */}
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Input label={t("newPool")} placeholder={t("poolNamePlaceholder")} value={newName} onChange={(e) => setNewName(e.target.value)} />
        </div>
        <Button variant="primary" onClick={createPool} loading={creating} icon={<Plus size={18} />}>{t("newPool")}</Button>
      </div>

      {error && <p className="text-sm text-warn">{error}</p>}

      {pools.length === 0 && <p className="text-sm text-foreground-faint">{t("emptyPools")}</p>}

      {pools.map((pool) => (
        <Card key={pool.id} padding="compact" className="flex flex-col gap-3">
          {/* Kopf: Name + aktiv */}
          <div className="flex items-center gap-2">
            <input
              className="flex-1 bg-transparent text-base font-semibold text-foreground border-b border-transparent focus:border-border focus:outline-none"
              value={pool.name}
              aria-label={t("poolNamePlaceholder")}
              onChange={(e) => patchPool(pool.id, (p) => ({ ...p, name: e.target.value, saved: false }))}
            />
            <button aria-label={t("delete")} onClick={() => deletePool(pool.id)} className="text-foreground-faint hover:text-warn transition p-1">
              <Trash2 size={18} />
            </button>
          </div>

          <Toggle label={t("active")} checked={pool.aktiv} onChange={(v) => patchPool(pool.id, (p) => ({ ...p, aktiv: v, saved: false }))} />

          <InlineSettingRow label={t("cooldownLabel")} unit={t("cooldownUnit")}>
            <NumberInput value={pool.cooldownMin} range={ZUFALL_COOLDOWN_MIN_RANGE} disabled={false} ariaLabel={t("cooldownLabel")}
              onCommit={(n) => patchPool(pool.id, (p) => ({ ...p, cooldownMin: n, saved: false }))} />
          </InlineSettingRow>

          <InlineSettingRow label={t("maxAddLabel")} unit={t("maxAddUnit")}>
            <NumberInput value={pool.maxAddH} range={ZUFALL_MAXADD_H_RANGE} disabled={false} ariaLabel={t("maxAddLabel")}
              onCommit={(n) => patchPool(pool.id, (p) => ({ ...p, maxAddH: n, saved: false }))} />
          </InlineSettingRow>

          {/* Optionen */}
          <div className="flex flex-col gap-2 pt-1">
            <p className="text-xs font-semibold uppercase tracking-wider text-foreground-faint">{t("options")}</p>
            {pool.options.length === 0 && <p className="text-xs text-foreground-faint">{t("noOptionsYet")}</p>}
            {pool.options.map((o, idx) => (
              <div key={o.key} className="rounded-lg border border-border-subtle p-3 flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Input placeholder={t("optionLabelPlaceholder")} value={o.label} onChange={(e) => updateOption(pool.id, o.key, { label: e.target.value })} className="!h-9" />
                  <button aria-label={t("moveUp")} disabled={idx === 0} onClick={() => moveOption(pool.id, idx, -1)} className="text-foreground-faint hover:text-foreground disabled:opacity-30 p-1"><ChevronUp size={16} /></button>
                  <button aria-label={t("moveDown")} disabled={idx === pool.options.length - 1} onClick={() => moveOption(pool.id, idx, 1)} className="text-foreground-faint hover:text-foreground disabled:opacity-30 p-1"><ChevronDown size={16} /></button>
                  <button aria-label={t("removeOption")} onClick={() => removeOption(pool.id, o.key)} className="text-foreground-faint hover:text-warn p-1"><Trash2 size={16} /></button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="min-w-[9rem] flex-1">
                    <Select aria-label={t("outcomeType")} value={o.outcomeType} options={outcomeOptions}
                      onChange={(e) => updateOption(pool.id, o.key, { outcomeType: e.target.value })} />
                  </div>
                  <InlineSettingRow label={t("weight")}>
                    <NumberInput value={o.weight} range={ZUFALL_WEIGHT_RANGE} disabled={false} ariaLabel={t("weight")}
                      onCommit={(n) => updateOption(pool.id, o.key, { weight: n })} />
                  </InlineSettingRow>
                </div>

                {/* typspezifische Parameter */}
                {(o.outcomeType === "TIME_ADD" || o.outcomeType === "TIME_SUB") && (
                  <Input type="number" inputMode="numeric" min={0} label={t("hours")} value={o.hours} onChange={(e) => updateOption(pool.id, o.key, { hours: e.target.value })} className="!h-9" />
                )}
                {(o.outcomeType === "REWARD") && (
                  <Input type="number" inputMode="numeric" min={0} label={t("windowHours")} value={o.windowHours} onChange={(e) => updateOption(pool.id, o.key, { windowHours: e.target.value })} className="!h-9" />
                )}
                {(o.outcomeType === "ORGASM_DIRECTIVE") && (
                  <div className="flex flex-col gap-2">
                    <Input type="number" inputMode="numeric" min={0} label={t("windowHours")} value={o.windowHours} onChange={(e) => updateOption(pool.id, o.key, { windowHours: e.target.value })} className="!h-9" />
                    <Toggle label={t("ruined")} checked={o.ruined} onChange={(v) => updateOption(pool.id, o.key, { ruined: v })} />
                  </div>
                )}
                {(o.outcomeType === "PENALTY") && (
                  <Input label={t("text")} value={o.text} onChange={(e) => updateOption(pool.id, o.key, { text: e.target.value })} className="!h-9" />
                )}
                {(o.outcomeType === "TASK") && (
                  <div className="flex flex-col gap-2">
                    <Input label={t("text")} value={o.text} onChange={(e) => updateOption(pool.id, o.key, { text: e.target.value })} className="!h-9" />
                    <Input type="number" inputMode="numeric" min={0} label={t("dueHours")} value={o.dueH} onChange={(e) => updateOption(pool.id, o.key, { dueH: e.target.value })} className="!h-9" />
                  </div>
                )}
              </div>
            ))}
            <Button variant="secondary" size="sm" onClick={() => addOption(pool.id)} icon={<Plus size={16} />}>{t("addOption")}</Button>
          </div>

          <div className="flex items-center gap-3 pt-1">
            <Button variant="primary" onClick={() => savePool(pool)} loading={pool.saving}>{t("save")}</Button>
            {pool.saved && <span className="text-sm text-ok">{t("saved")}</span>}
          </div>
        </Card>
      ))}
    </div>
  );
}
