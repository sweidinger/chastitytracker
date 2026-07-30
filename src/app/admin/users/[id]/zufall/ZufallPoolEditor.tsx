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
  ZUFALL_OUTCOME_TYPES, ZUFALL_WEIGHT_RANGE, ZUFALL_COOLDOWN_MIN_RANGE, ZUFALL_MAXADD_MIN_RANGE,
} from "@/lib/constants";

// Strafbuch-Schwere + Vorschläge kommen als Prop vom Server (die Quelle `strafurteilService` zieht
// serverseitige Module mit und darf NICHT direkt in diese Client-Komponente importiert werden).
export type OffenseSeverity = "leicht" | "mittel" | "schwer";
export interface PenaltySuggestion {
  label: string;
  action?: string;
  param?: { field: "hours" | "windowHours"; label: string; default: number };
}
export type PenaltySuggestionMap = Record<OffenseSeverity, PenaltySuggestion[]>;

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
  /** Deckel für Sperrzeit-Verlängerung EINER Ziehung — jetzt in MINUTEN (Spaltenname maxAddH historisch). */
  maxAddH: number;
  options: EditorOption[];
}
export interface SessionCategory {
  id: string;
  name: string;
  maxSessionMinutes: number;
  requiresVideo: boolean;
  orgasmusZiel: string;
  devices: { id: string; name: string }[];
}

const SEVERITIES: OffenseSeverity[] = ["leicht", "mittel", "schwer"];
const ORGASM_ZIELE = ["KEINE", "ERFORDERLICH", "VERBOTEN"] as const;

/** Lokaler Bearbeitungs-Stand einer Option — die typspezifischen Parameter als Strings, damit die
 *  Eingabefelder frei bearbeitbar bleiben; beim Speichern werden sie zu outcomeJson serialisiert. */
interface DraftOption {
  key: string;
  label: string;
  weight: number;
  outcomeType: string;
  // TIME_ADD / TIME_SUB (Minuten)
  minutes: string;
  // REWARD / ORGASM_DIRECTIVE
  windowHours: string;
  ruined: boolean;
  // PENALTY (Strafbuch-Auswahl)
  penaltySeverity: OffenseSeverity;
  penaltyIdx: number;
  penaltyParam: string;
  // SESSION_REQUEST
  categoryId: string;
  minMinuten: string;
  delayMinutes: string;
  deviceId: string;
  requireVideo: boolean;
  orgasmusZiel: string;
  orgasmusRuiniert: boolean;
  deadlineHours: string;
  nachricht: string;
  istStrafe: boolean;
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

function toDraftOption(o: EditorOption, sugg: PenaltySuggestionMap): DraftOption {
  let p: Record<string, unknown> = {};
  if (o.outcomeJson) { try { p = JSON.parse(o.outcomeJson) ?? {}; } catch { p = {}; } }
  const s = (v: unknown) => (typeof v === "number" || typeof v === "string" ? String(v) : "");

  // PENALTY: Schwere + gewählter Vorschlag aus dem eingefrorenen Label rekonstruieren.
  let penaltySeverity: OffenseSeverity = "mittel";
  let penaltyIdx = 0;
  let penaltyParam = "";
  if (o.outcomeType === "PENALTY") {
    if (typeof p.severity === "string" && (SEVERITIES as string[]).includes(p.severity)) penaltySeverity = p.severity as OffenseSeverity;
    const arr = sugg[penaltySeverity] ?? [];
    const found = arr.findIndex((x) => x.label === p.penaltyLabel);
    penaltyIdx = found >= 0 ? found : 0;
    const sug = arr[penaltyIdx];
    if (sug?.param) penaltyParam = s(p[sug.param.field] ?? sug.param.default);
  }

  return {
    key: nextKey(),
    label: o.label,
    weight: o.weight,
    outcomeType: o.outcomeType,
    minutes: s(p.minutes),
    windowHours: s(p.windowHours),
    ruined: !!p.ruined,
    penaltySeverity,
    penaltyIdx,
    penaltyParam,
    categoryId: typeof p.categoryId === "string" ? p.categoryId : "",
    minMinuten: s(p.minMinuten),
    delayMinutes: s(p.delayMinutes),
    deviceId: typeof p.deviceId === "string" ? p.deviceId : "",
    requireVideo: !!p.requireVideo,
    orgasmusZiel: typeof p.orgasmusZiel === "string" ? p.orgasmusZiel : "KEINE",
    orgasmusRuiniert: !!p.orgasmusRuiniert,
    deadlineHours: s(p.deadlineHours),
    nachricht: typeof p.nachricht === "string" ? p.nachricht : "",
    istStrafe: !!p.istStrafe,
  };
}
function toDraftPool(p: EditorPool, sugg: PenaltySuggestionMap): DraftPool {
  return { id: p.id, name: p.name, aktiv: p.aktiv, cooldownMin: p.cooldownMin, maxAddH: p.maxAddH, options: p.options.map((o) => toDraftOption(o, sugg)), saving: false, saved: false };
}

/** Baut outcomeJson aus den Draft-Parametern je Typ (spiegelt validateOptions im Service). */
function buildOutcomeJson(o: DraftOption, sugg: PenaltySuggestionMap): string | null {
  const p: Record<string, unknown> = {};
  switch (o.outcomeType) {
    case "TIME_ADD":
    case "TIME_SUB":
      p.minutes = Number(o.minutes) || 0;
      break;
    case "ORGASM_DIRECTIVE":
      p.windowHours = Number(o.windowHours) || 24;
      if (o.ruined) p.ruined = true;
      break;
    case "REWARD":
      if (o.windowHours) p.windowHours = Number(o.windowHours);
      break;
    case "PENALTY": {
      const sug = sugg[o.penaltySeverity]?.[o.penaltyIdx];
      if (sug) {
        p.severity = o.penaltySeverity;
        p.penaltyLabel = sug.label;
        if (sug.action) p.action = sug.action;
        if (sug.param) p[sug.param.field] = Number(o.penaltyParam) || sug.param.default;
      }
      break;
    }
    case "SESSION_REQUEST":
      if (o.categoryId) p.categoryId = o.categoryId;
      if (o.minMinuten) p.minMinuten = Number(o.minMinuten);
      if (o.delayMinutes) p.delayMinutes = Number(o.delayMinutes);
      if (o.deviceId) p.deviceId = o.deviceId;
      if (o.requireVideo) p.requireVideo = true;
      p.orgasmusZiel = o.orgasmusZiel;
      if (o.orgasmusZiel === "ERFORDERLICH" && o.orgasmusRuiniert) p.orgasmusRuiniert = true;
      if (o.deadlineHours) p.deadlineHours = Number(o.deadlineHours);
      if (o.nachricht.trim()) p.nachricht = o.nachricht.trim();
      if (o.istStrafe) p.istStrafe = true;
      break;
    case "NOTHING":
    default:
      return null;
  }
  return Object.keys(p).length ? JSON.stringify(p) : null;
}

const emptyOption = (): DraftOption => ({
  key: nextKey(), label: "", weight: ZUFALL_WEIGHT_RANGE.fallback, outcomeType: "NOTHING",
  minutes: "", windowHours: "", ruined: false,
  penaltySeverity: "mittel", penaltyIdx: 0, penaltyParam: "",
  categoryId: "", minMinuten: "", delayMinutes: "", deviceId: "", requireVideo: false,
  orgasmusZiel: "KEINE", orgasmusRuiniert: false, deadlineHours: "", nachricht: "", istStrafe: false,
});

const OUTCOME_OPTIONS = (t: (k: string) => string) =>
  ZUFALL_OUTCOME_TYPES.map((v) => ({ value: v, label: t(`outcomes.${v}`) }));

export default function ZufallPoolEditor({
  userId, initialPools, categories = [], penaltySuggestions,
}: { userId: string; initialPools: EditorPool[]; categories?: SessionCategory[]; penaltySuggestions: PenaltySuggestionMap }) {
  const t = useTranslations("zufall");
  const [pools, setPools] = useState<DraftPool[]>(initialPools.map((p) => toDraftPool(p, penaltySuggestions)));
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  /** Editor-seitige Prüfung (spiegelt validateOptions). Gibt eine Liste von Problemen zurück; ist sie
   *  nicht leer, bleibt „Speichern" gesperrt. */
  function optionIssue(o: DraftOption): string | null {
    if (!o.label.trim()) return t("valNeedLabel");
    switch (o.outcomeType) {
      case "TIME_ADD":
      case "TIME_SUB":
        if (!(Number(o.minutes) > 0)) return t("valNeedMinutes");
        return null;
      case "ORGASM_DIRECTIVE":
        if (!(Number(o.windowHours) > 0)) return t("valNeedWindow");
        return null;
      case "SESSION_REQUEST":
        if (!o.categoryId) return t("valNeedCategory");
        return null;
      default:
        return null;
    }
  }
  function poolIssues(pool: DraftPool): string[] {
    const issues: string[] = [];
    if (pool.options.length === 0) issues.push(t("valNeedOption"));
    for (const o of pool.options) {
      const iss = optionIssue(o);
      if (iss && !issues.includes(iss)) issues.push(iss);
    }
    return issues;
  }

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
    if (poolIssues(pool).length > 0) return;
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
            outcomeJson: buildOutcomeJson(o, penaltySuggestions),
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

      {pools.map((pool) => {
        const issues = poolIssues(pool);
        return (
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
            <NumberInput value={pool.maxAddH} range={ZUFALL_MAXADD_MIN_RANGE} disabled={false} ariaLabel={t("maxAddLabel")}
              onCommit={(n) => patchPool(pool.id, (p) => ({ ...p, maxAddH: n, saved: false }))} />
          </InlineSettingRow>

          {/* Optionen */}
          <div className="flex flex-col gap-2 pt-1">
            <p className="text-xs font-semibold uppercase tracking-wider text-foreground-faint">{t("options")}</p>
            {pool.options.length === 0 && <p className="text-xs text-foreground-faint">{t("noOptionsYet")}</p>}
            {pool.options.map((o, idx) => {
              const penaltyList = penaltySuggestions[o.penaltySeverity] ?? [];
              const penaltySug = penaltyList[o.penaltyIdx];
              const selectedCat = categories.find((c) => c.id === o.categoryId) ?? null;
              return (
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
                  <Input type="number" inputMode="numeric" min={0} label={t("minutes")} value={o.minutes} onChange={(e) => updateOption(pool.id, o.key, { minutes: e.target.value })} className="!h-9" />
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
                  <div className="flex flex-col gap-2">
                    <Select label={t("penaltySeverity")} value={o.penaltySeverity}
                      options={SEVERITIES.map((sv) => ({ value: sv, label: t(`severity.${sv}`) }))}
                      onChange={(e) => updateOption(pool.id, o.key, { penaltySeverity: e.target.value as OffenseSeverity, penaltyIdx: 0, penaltyParam: "" })} />
                    <Select label={t("penaltyChoice")} value={String(o.penaltyIdx)}
                      options={penaltyList.map((sg, i) => ({ value: String(i), label: sg.label }))}
                      onChange={(e) => updateOption(pool.id, o.key, { penaltyIdx: Number(e.target.value), penaltyParam: "" })} />
                    {penaltySug?.param && (
                      <Input type="number" inputMode="numeric" min={0} label={penaltySug.param.label}
                        value={o.penaltyParam} placeholder={String(penaltySug.param.default)}
                        onChange={(e) => updateOption(pool.id, o.key, { penaltyParam: e.target.value })} className="!h-9" />
                    )}
                  </div>
                )}
                {(o.outcomeType === "SESSION_REQUEST") && (
                  <div className="flex flex-col gap-2">
                    {categories.length === 0 ? (
                      <p className="text-xs text-warn">{t("valNeedCategory")}</p>
                    ) : (
                      <>
                        <Select label={t("sessionCategory")} value={o.categoryId}
                          placeholder={t("sessionCategoryPlaceholder")}
                          options={categories.map((c) => ({ value: c.id, label: `${c.name} (max. ${c.maxSessionMinutes} Min.)` }))}
                          onChange={(e) => updateOption(pool.id, o.key, { categoryId: e.target.value, deviceId: "" })} />
                        <div className="flex flex-wrap gap-2">
                          <Input type="number" inputMode="numeric" min={0} label={t("sessionMinDuration")} value={o.minMinuten} onChange={(e) => updateOption(pool.id, o.key, { minMinuten: e.target.value })} className="!h-9" />
                          <Input type="number" inputMode="numeric" min={0} label={t("sessionNotBefore")} value={o.delayMinutes} onChange={(e) => updateOption(pool.id, o.key, { delayMinutes: e.target.value })} className="!h-9" />
                        </div>
                        <Select label={t("sessionDevice")} value={o.deviceId}
                          options={[{ value: "", label: t("sessionAnyDevice") }, ...(selectedCat?.devices ?? []).map((d) => ({ value: d.id, label: d.name }))]}
                          onChange={(e) => updateOption(pool.id, o.key, { deviceId: e.target.value })} />
                        <Select label={t("sessionOrgasmGoal")} value={o.orgasmusZiel}
                          options={ORGASM_ZIELE.map((z) => ({ value: z, label: t(`orgasmGoal.${z}`) }))}
                          onChange={(e) => updateOption(pool.id, o.key, { orgasmusZiel: e.target.value })} />
                        {o.orgasmusZiel === "ERFORDERLICH" && (
                          <Toggle label={t("ruined")} checked={o.orgasmusRuiniert} onChange={(v) => updateOption(pool.id, o.key, { orgasmusRuiniert: v })} />
                        )}
                        <Toggle label={t("sessionRequireProof")} checked={o.requireVideo} onChange={(v) => updateOption(pool.id, o.key, { requireVideo: v })} />
                        <Toggle label={t("sessionAsPenalty")} checked={o.istStrafe} onChange={(v) => updateOption(pool.id, o.key, { istStrafe: v })} />
                        <Input type="number" inputMode="numeric" min={0} label={t("sessionDeadline")} value={o.deadlineHours} onChange={(e) => updateOption(pool.id, o.key, { deadlineHours: e.target.value })} className="!h-9" />
                        <Input label={t("sessionInstruction")} placeholder={t("sessionInstructionPlaceholder")} value={o.nachricht} onChange={(e) => updateOption(pool.id, o.key, { nachricht: e.target.value })} className="!h-9" />
                      </>
                    )}
                  </div>
                )}
              </div>
              );
            })}
            <Button variant="secondary" size="sm" onClick={() => addOption(pool.id)} icon={<Plus size={16} />}>{t("addOption")}</Button>
          </div>

          {issues.length > 0 && (
            <ul className="flex flex-col gap-0.5">
              {issues.map((iss, i) => <li key={i} className="text-xs text-warn">• {iss}</li>)}
            </ul>
          )}

          <div className="flex items-center gap-3 pt-1">
            <Button variant="primary" onClick={() => savePool(pool)} loading={pool.saving} disabled={issues.length > 0}>{t("save")}</Button>
            {pool.saved && <span className="text-sm text-ok">{t("saved")}</span>}
          </div>
        </Card>
        );
      })}
    </div>
  );
}
