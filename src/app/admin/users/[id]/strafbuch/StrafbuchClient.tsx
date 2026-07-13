"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle, ChevronDown, XCircle, Clock } from "lucide-react";
import ImageViewer from "@/app/components/ImageViewer";

export type OffenseStoredType =
  | "KONTROLLANFORDERUNG"
  | "OEFFNEN_ENTRY"
  | "VERSCHLUSS_ANFORDERUNG"
  | "FALSCHES_GERAET"
  | "ORGASMUS_ANWEISUNG"
  | "SESSION_VERSAEUMT"
  | "EREKTION"
  | "PAUSE_OVERAGE";

export type OffenseSeverity = "leicht" | "mittel" | "schwer";

/** Optionale Straf-Aktion, die beim Bestrafen mitgeschickt wird (Server führt sie aus). */
export type PenaltyActionInput = {
  type: string;
  hours?: number;
  windowHours?: number;
  oeffnenErlaubt?: boolean;
  categoryId?: string;
  minMinuten?: number;
  delayMinutes?: number;
  deviceId?: string;
  requireVideo?: boolean;
  reinigungErlaubt?: boolean;
  toiletteErlaubt?: boolean;
  dauerH?: number;
  fristH?: number;
  device?: "CAGE" | "PLUG";
  deadlineH?: number;
  requireCode?: boolean;
};

/** Session-Kategorie (+ Geräte) für die Inline-Konfiguration der Pflicht-Session-Aktion. */
export type SessionCategoryOption = { id: string; name: string; maxSessionMinutes: number; requiresVideo: boolean; devices: { id: string; name: string }[] };
/** Ein Vorschlags-Chip: Text + optionale Aktion mit optionalem Zahlen-Parameter. */
export type PenaltySuggestion = { label: string; action?: string; param?: { field: "hours" | "windowHours"; label: string; default: number } };

/** Eine vereinheitlichte Vergehens-Zeile — alle Typen teilen sich dieselbe Karte + Urteils-Slot.
 *  Formatierung (typeLabel/headline/detail) macht die Server-Seite. */
export interface OffenseRow {
  refId: string;
  offenseType: OffenseStoredType;
  severity: OffenseSeverity;
  /** true = Schwere wurde durch Wiederholung hochgestuft (Phase 2). */
  escalated?: boolean;
  typeLabel: string;
  headline: string;
  detail: string | null;
  note: string | null;
}

export interface StrafeRecordData {
  refId: string;
  status: string; // "PUNISHED" | "DISMISSED"
  bestraftDatumStr: string;
  notiz: string | null;
  reason: string | null;
  judgedBy: string | null;
  done: boolean;
  erledigtAtStr: string | null;
  // Erledigungs-Meldung des Subs (wartet auf Prüfung)
  gemeldetAtStr: string | null;
  nachweisUrl: string | null;
  erledigungNotiz: string | null;
  ablehnungGrund: string | null;
}

interface Labels {
  strafbuchNoEntries: string;
  strafbuchAlleVergehenBestraft: string;
  strafbuchWurdeBestraft: string;
  strafbuchAbbrechen: string;
  strafbuchRueckgaengig: string;
  strafbuchAlleAnzeigen: string;
  strafbuchOffeneAnzeigen: string;
  strafbuchOffen: string;
  strafbuchGesamt: string;
  strafbuchVerwerfen: string;
  strafbuchVerworfenBadge: string;
  strafbuchBegruendung: string;
  strafbuchUrteilKI: string;
  strafbuchStrafeLabel: string;
  strafbuchStrafePlaceholder: string;
  strafbuchStrafeVerhaengen: string;
  strafbuchStrafeBadge: string;
  strafbuchErledigtBadge: string;
  strafbuchAlsErledigt: string;
  strafbuchWiederOffen: string;
  strafbuchGemeldetBadge: string;
  strafbuchNachweis: string;
  strafbuchBestaetigen: string;
  strafbuchAblehnen: string;
  strafbuchAblehnenPlaceholder: string;
  strafbuchAbgelehntBadge: string;
  strafbuchVergehen: string;
  strafbuchVorschlaege: string;
  schwereSchwer: string;
  schwereMittel: string;
  schwereLeicht: string;
  strafbuchLegende: string;
  strafbuchLegendeHint: string;
  strafbuchHochgestuft: string;
  strafbuchAktion: string;
  strafbuchAktionNone: string;
  strafbuchAktionStunden: string;
  strafbuchAktionStundenFehlt: string;
  strafbuchAktionFehlgeschlagen: string;
  strafbuchStrafeOderAktion: string;
  strafbuchAktionLabels: Record<string, string>;
  aktSessionKategorie: string;
  aktSessionMin: string;
  aktSessionDelay: string;
  aktSessionGeraet: string;
  aktSessionGeraetAny: string;
  aktSessionVideo: string;
  aktOrgasmusOeffnen: string;
  aktSperreReinigung: string;
  aktSperreToilette: string;
  aktPlugDauer: string;
  aktPlugFrist: string;
  aktKontrolleGeraet: string;
  aktKontrolleGeraetAllg: string;
  aktKontrolleGeraetCage: string;
  aktKontrolleGeraetPlug: string;
  aktKontrolleFrist: string;
  aktKontrolleCode: string;
  aktEntzugKeinGuthaben: string;
}

/** Eine Zeile der Schwere-Übersicht (Legende). */
export interface SeverityMatrixRow {
  severity: OffenseSeverity;
  offenses: string[];
  suggestions: string[];
}

interface Props {
  userId: string;
  offenses: OffenseRow[];
  strafeRecords: StrafeRecordData[];
  labels: Labels;
  /** Straf-Vorschläge je Schwere-Stufe (Chip = Text + optionale Aktion). */
  suggestions: Record<OffenseSeverity, PenaltySuggestion[]>;
  /** Schwere-Übersicht (Legende): je Stufe zugehörige Vergehen + Vorschläge. */
  matrix: SeverityMatrixRow[];
  /** Session-Kategorien (+ Geräte) für die Pflicht-Session-Aktion. */
  sessionCategories: SessionCategoryOption[];
  /** Aktuelles Belohnungs-Guthaben — Entzug (deny_orgasm) ist bei Stand 0 gesperrt. */
  verdienteOrgasmen: number;
}

const SEV_STYLE: Record<OffenseSeverity, string> = {
  schwer: "text-warn border-warn",
  mittel: "text-sperrzeit border-[var(--color-sperrzeit)]",
  leicht: "text-foreground-faint border-border",
};

const fieldCls = "w-full bg-surface-raised border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus-visible:outline-2 focus-visible:outline-focus-ring transition";

export default function StrafbuchClient({ userId, offenses, strafeRecords, labels, suggestions, matrix, sessionCategories, verdienteOrgasmen }: Props) {
  const router = useRouter();
  const sevLabel: Record<OffenseSeverity, string> = { schwer: labels.schwereSchwer, mittel: labels.schwereMittel, leicht: labels.schwereLeicht };
  const [showLegend, setShowLegend] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [openFormId, setOpenFormId] = useState<string | null>(null);
  const [openDismissId, setOpenDismissId] = useState<string | null>(null);
  // Ablehnung einer gemeldeten Erledigung (Begründung ist Pflicht)
  const [rejectFor, setRejectFor] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  // Urteils-Lebenszyklus: bestraft (PUNISHED, offen→erledigt) | verworfen (DISMISSED) | offen (kein Record).
  const punishedIds = new Set(strafeRecords.filter(r => r.status === "PUNISHED").map(r => r.refId));
  const dismissedIds = new Set(strafeRecords.filter(r => r.status === "DISMISSED").map(r => r.refId));
  const closedIds = new Set(strafeRecords.filter(r => r.status === "DISMISSED" || (r.status === "PUNISHED" && r.done)).map(r => r.refId));

  const openOffenses = offenses.filter(o => !closedIds.has(o.refId));
  const hasAny = offenses.length > 0;
  const hasClosed = offenses.some(o => closedIds.has(o.refId));
  const display = showAll ? offenses : openOffenses;

  async function submitJudgment(refId: string, offenseType: OffenseStoredType, status: "PUNISHED" | "DISMISSED", reason: string, action: PenaltyActionInput | null): Promise<{ error: string | null; actionError?: string | null }> {
    const res = await fetch("/api/admin/strafe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, offenseType, refId, status, reason, action }),
    });
    if (res.ok) {
      const d = await res.json().catch(() => ({}));
      if (d.actionError) return { error: null, actionError: d.actionError };
      router.refresh();
      return { error: null };
    }
    const d = await res.json().catch(() => ({}));
    return { error: d.error || "Fehler" };
  }

  async function handleUndo(refId: string) {
    await fetch("/api/admin/strafe", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refId }) });
    router.refresh();
  }

  async function markDone(refId: string, done: boolean) {
    await fetch("/api/admin/strafe", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refId, done }) });
    router.refresh();
  }

  /** Vom Sub gemeldete Erledigung prüfen: bestätigen (abhaken) oder mit Begründung ablehnen. */
  async function reviewCompletion(refId: string, action: "confirm" | "reject", grund?: string) {
    await fetch("/api/admin/strafe", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refId, action, grund }),
    });
    setRejectFor(null);
    setRejectReason("");
    router.refresh();
  }

  /** Meldung des Subs: Nachweis + Notiz + Prüf-Buttons. */
  function CompletionReport({ record }: { record: StrafeRecordData }) {
    const open = rejectFor === record.refId;
    return (
      <div className="mt-1 rounded-xl border border-[var(--color-inspect)] bg-[color-mix(in_srgb,var(--color-inspect)_8%,transparent)] px-3 py-2.5 flex flex-col gap-2">
        <div className="flex items-center gap-1.5">
          <Clock size={12} className="text-[var(--color-inspect)] shrink-0" />
          <span className="text-xs font-semibold text-[var(--color-inspect)]">
            {labels.strafbuchGemeldetBadge} {record.gemeldetAtStr}
          </span>
        </div>
        {record.erledigungNotiz && <p className="text-xs text-foreground-muted break-words">„{record.erledigungNotiz}"</p>}
        {record.nachweisUrl && (
          <ImageViewer src={record.nachweisUrl} alt={labels.strafbuchNachweis} width={96} height={96} className="rounded-lg" />
        )}
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => reviewCompletion(record.refId, "confirm")}
            className="text-xs font-medium text-[var(--color-ok)] border border-[var(--color-ok)] bg-[color-mix(in_srgb,var(--color-ok)_8%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-ok)_15%,transparent)] transition px-2.5 py-1 rounded-lg flex items-center gap-1">
            <CheckCircle size={11} /> {labels.strafbuchBestaetigen}
          </button>
          <button type="button" onClick={() => setRejectFor(open ? null : record.refId)}
            className="text-xs font-medium text-warn border border-warn hover:bg-warn-bg transition px-2.5 py-1 rounded-lg flex items-center gap-1">
            <XCircle size={11} /> {labels.strafbuchAblehnen}
          </button>
        </div>
        {open && (
          <div className="flex flex-col gap-2">
            <textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} rows={2}
              placeholder={labels.strafbuchAblehnenPlaceholder}
              className="w-full text-sm rounded-xl border border-border bg-surface px-3 py-2 resize-none" />
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => { setRejectFor(null); setRejectReason(""); }}
                className="text-xs text-foreground-faint hover:text-foreground-muted transition px-3 py-1.5 rounded-lg border border-border">
                {labels.strafbuchAbbrechen}
              </button>
              <button type="button" disabled={!rejectReason.trim()}
                onClick={() => reviewCompletion(record.refId, "reject", rejectReason)}
                className="text-xs font-semibold text-white bg-warn px-3 py-1.5 rounded-lg disabled:opacity-50 transition hover:opacity-90">
                {labels.strafbuchAblehnen}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  function JudgmentForm({ refId, offenseType, status, label, placeholder, submitLabel, submitIcon, submitClass, onClose, penaltySuggestions }: {
    refId: string; offenseType: OffenseStoredType; status: "PUNISHED" | "DISMISSED";
    label: string; placeholder?: string; submitLabel: string; submitIcon: React.ReactNode; submitClass: string; onClose: () => void;
    penaltySuggestions?: PenaltySuggestion[];
  }) {
    const [text, setText] = useState("");
    const [activeSug, setActiveSug] = useState<PenaltySuggestion | null>(null);
    const [paramValue, setParamValue] = useState("");
    // Aktions-Konfiguration
    const [oeffnenErlaubt, setOeffnenErlaubt] = useState(false);
    const [sCatId, setSCatId] = useState("");
    const [sMin, setSMin] = useState("");
    const [sDelay, setSDelay] = useState("");
    const [sDevId, setSDevId] = useState("");
    const [sReqVideo, setSReqVideo] = useState(false);
    // extend_lock
    const [reinigungErl, setReinigungErl] = useState(false);
    const [toiletteErl, setToiletteErl] = useState(false);
    // bigger_plug
    const [plugDauer, setPlugDauer] = useState("");
    const [plugFrist, setPlugFrist] = useState("");
    // extra_control
    const [kDevice, setKDevice] = useState<"" | "CAGE" | "PLUG">("");
    const [kDeadline, setKDeadline] = useState("4");
    const [kReqCode, setKReqCode] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    function pickSuggestion(s: PenaltySuggestion) {
      if (s.action) {
        // Aktions-Chip: Aktion umschalten (einzeln), Text NICHT anhäufen.
        if (activeSug?.action === s.action) { setActiveSug(null); setParamValue(""); return; }
        setActiveSug(s);
        setParamValue(s.param ? String(s.param.default) : "");
        if (s.action === "mandatory_session") {
          const c0 = sessionCategories[0];
          setSCatId(c0?.id ?? ""); setSReqVideo(c0?.requiresVideo ?? false); setSMin(""); setSDelay(""); setSDevId("");
        }
        if (s.action === "ruined_orgasm") setOeffnenErlaubt(false);
        if (s.action === "extend_lock") { setReinigungErl(false); setToiletteErl(false); }
        if (s.action === "bigger_plug") { setPlugDauer(""); setPlugFrist(""); }
        if (s.action === "extra_control") { setKDevice(""); setKDeadline("4"); setKReqCode(true); }
      } else {
        // Text-Chip: Label anhängen, ohne Duplikat.
        setText(prev => {
          const t = prev.trim();
          if (!t) return s.label;
          return t.split("; ").includes(s.label) ? t : `${t}; ${s.label}`;
        });
      }
    }
    async function submit(e: React.FormEvent) {
      e.preventDefault();
      let action: PenaltyActionInput | null = null;
      if (status === "PUNISHED" && activeSug?.action) {
        action = { type: activeSug.action };
        if (activeSug.param) {
          const v = Number(paramValue);
          if (!Number.isFinite(v) || v <= 0) { setError(labels.strafbuchAktionStundenFehlt); return; }
          action[activeSug.param.field] = v;
        }
        if (activeSug.action === "ruined_orgasm") action.oeffnenErlaubt = oeffnenErlaubt;
        if (activeSug.action === "mandatory_session") {
          if (sCatId) action.categoryId = sCatId;
          const mn = Number(sMin); if (Number.isFinite(mn) && mn > 0) action.minMinuten = mn;
          const dl = Number(sDelay); if (Number.isFinite(dl) && dl > 0) action.delayMinutes = dl;
          if (sDevId) action.deviceId = sDevId;
          action.requireVideo = sReqVideo;
        }
        if (activeSug.action === "extend_lock") {
          action.reinigungErlaubt = reinigungErl;
          action.toiletteErlaubt = toiletteErl;
        }
        if (activeSug.action === "bigger_plug") {
          const dh = Number(plugDauer); if (Number.isFinite(dh) && dh > 0) action.dauerH = dh;
          const fh = Number(plugFrist); if (Number.isFinite(fh) && fh > 0) action.fristH = fh;
        }
        if (activeSug.action === "extra_control") {
          if (kDevice) action.device = kDevice;
          const dl = Number(kDeadline); if (Number.isFinite(dl) && dl > 0) action.deadlineH = dl;
          action.requireCode = kReqCode;
        }
      }
      // Straftext: Freitext, sonst das Label der gewählten Aktion.
      const finalText = text.trim() || (status === "PUNISHED" && activeSug?.action ? activeSug.label : "");
      if (status === "PUNISHED" && !finalText) { setError(labels.strafbuchStrafeOderAktion); return; }
      setSaving(true); setError("");
      const r = await submitJudgment(refId, offenseType, status, finalText, action);
      setSaving(false);
      if (r.error) setError(r.error);
      else if (r.actionError) setError(`${labels.strafbuchAktionFehlgeschlagen}: ${r.actionError}`);
      else onClose();
    }
    const selCat = sessionCategories.find((c) => c.id === sCatId) ?? null;
    return (
      <form onSubmit={submit} className="mt-2 bg-surface-raised rounded-xl border border-border p-3 flex flex-col gap-2">
        {penaltySuggestions && penaltySuggestions.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-semibold text-foreground-faint">{labels.strafbuchVorschlaege}</p>
            <div className="flex flex-wrap gap-1.5">
              {penaltySuggestions.map((s, i) => {
                const isActive = !!s.action && activeSug?.action === s.action;
                // Entzug nur möglich, wenn Guthaben vorhanden ist.
                const disabled = s.action === "deny_orgasm" && verdienteOrgasmen < 1;
                return (
                  <button key={i} type="button" disabled={disabled}
                    onClick={() => pickSuggestion(s)}
                    title={disabled ? labels.aktEntzugKeinGuthaben : undefined}
                    className={`text-xs border rounded-lg px-2 py-1 transition text-left ${disabled ? "opacity-40 cursor-not-allowed border-border text-foreground-faint" : isActive ? "border-[var(--color-ok)] text-[var(--color-ok)] bg-[color-mix(in_srgb,var(--color-ok)_10%,transparent)]" : "text-foreground-muted border-border hover:bg-background-hover"}`}>
                    {s.action ? "⚡ " : ""}{s.label}
                  </button>
                );
              })}
            </div>
            {status === "PUNISHED" && activeSug?.action && (
              <div className="flex flex-col gap-2 border-t border-border-subtle pt-2 mt-0.5">
                {/* Pflicht-Session: vollständige Konfiguration */}
                {activeSug.action === "mandatory_session" && (
                  <>
                    <div>
                      <label className="block text-xs text-foreground-faint mb-1">{labels.aktSessionKategorie}</label>
                      <select value={sCatId} onChange={e => { setSCatId(e.target.value); const c = sessionCategories.find(x => x.id === e.target.value); setSReqVideo(c?.requiresVideo ?? false); setSDevId(""); }} className={fieldCls}>
                        {sessionCategories.map(c => <option key={c.id} value={c.id}>{c.name} (max. {c.maxSessionMinutes} Min.)</option>)}
                      </select>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <div className="w-28">
                        <label className="block text-xs text-foreground-faint mb-1">{labels.aktSessionMin}</label>
                        <input type="number" min={1} value={sMin} onChange={e => setSMin(e.target.value)} placeholder="—" className={fieldCls} />
                      </div>
                      <div className="w-24">
                        <label className="block text-xs text-foreground-faint mb-1">{labels.aktSessionDelay}</label>
                        <input type="number" min={0} value={sDelay} onChange={e => setSDelay(e.target.value)} placeholder="0" className={fieldCls} />
                      </div>
                    </div>
                    {selCat && selCat.devices.length > 0 && (
                      <div>
                        <label className="block text-xs text-foreground-faint mb-1">{labels.aktSessionGeraet}</label>
                        <select value={sDevId} onChange={e => setSDevId(e.target.value)} className={fieldCls}>
                          <option value="">{labels.aktSessionGeraetAny}</option>
                          {selCat.devices.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                        </select>
                      </div>
                    )}
                    <label className="flex items-center gap-2 text-xs text-foreground-muted cursor-pointer">
                      <input type="checkbox" checked={sReqVideo} disabled={selCat?.requiresVideo} onChange={e => setSReqVideo(e.target.checked)} className="size-4 accent-foreground disabled:opacity-50" />
                      {labels.aktSessionVideo}
                    </label>
                  </>
                )}
                {/* Ruinierter Orgasmus: Öffnen erlaubt */}
                {activeSug.action === "ruined_orgasm" && (
                  <label className="flex items-center gap-2 text-xs text-foreground-muted cursor-pointer">
                    <input type="checkbox" checked={oeffnenErlaubt} onChange={e => setOeffnenErlaubt(e.target.checked)} className="size-4 accent-foreground" />
                    {labels.aktOrgasmusOeffnen}
                  </label>
                )}
                {/* Sperrzeit verlängern: Reinigung/Toilette weiter erlaubt */}
                {activeSug.action === "extend_lock" && (
                  <>
                    <label className="flex items-center gap-2 text-xs text-foreground-muted cursor-pointer">
                      <input type="checkbox" checked={reinigungErl} onChange={e => setReinigungErl(e.target.checked)} className="size-4 accent-foreground" />
                      {labels.aktSperreReinigung}
                    </label>
                    <label className="flex items-center gap-2 text-xs text-foreground-muted cursor-pointer">
                      <input type="checkbox" checked={toiletteErl} onChange={e => setToiletteErl(e.target.checked)} className="size-4 accent-foreground" />
                      {labels.aktSperreToilette}
                    </label>
                  </>
                )}
                {/* Nächstgrößerer Plug: Mindest-Tragedauer + Frist */}
                {activeSug.action === "bigger_plug" && (
                  <div className="flex flex-wrap gap-2">
                    <div className="w-28">
                      <label className="block text-xs text-foreground-faint mb-1">{labels.aktPlugDauer}</label>
                      <input type="number" min={1} value={plugDauer} onChange={e => setPlugDauer(e.target.value)} placeholder="—" className={fieldCls} />
                    </div>
                    <div className="w-28">
                      <label className="block text-xs text-foreground-faint mb-1">{labels.aktPlugFrist}</label>
                      <input type="number" min={1} value={plugFrist} onChange={e => setPlugFrist(e.target.value)} placeholder="—" className={fieldCls} />
                    </div>
                  </div>
                )}
                {/* Extra-Kontrolle: Gerät + Frist + Code-Pflicht */}
                {activeSug.action === "extra_control" && (
                  <>
                    <div className="flex flex-wrap gap-2">
                      <div className="w-32">
                        <label className="block text-xs text-foreground-faint mb-1">{labels.aktKontrolleGeraet}</label>
                        <select value={kDevice} onChange={e => setKDevice(e.target.value as "" | "CAGE" | "PLUG")} className={fieldCls}>
                          <option value="">{labels.aktKontrolleGeraetAllg}</option>
                          <option value="CAGE">{labels.aktKontrolleGeraetCage}</option>
                          <option value="PLUG">{labels.aktKontrolleGeraetPlug}</option>
                        </select>
                      </div>
                      <div className="w-24">
                        <label className="block text-xs text-foreground-faint mb-1">{labels.aktKontrolleFrist}</label>
                        <input type="number" min={1} value={kDeadline} onChange={e => setKDeadline(e.target.value)} className={fieldCls} />
                      </div>
                    </div>
                    <label className="flex items-center gap-2 text-xs text-foreground-muted cursor-pointer">
                      <input type="checkbox" checked={kReqCode} onChange={e => setKReqCode(e.target.checked)} className="size-4 accent-foreground" />
                      {labels.aktKontrolleCode}
                    </label>
                  </>
                )}
                {/* Zahlen-Parameter: Sperrzeit-Stunden / Fenster / Frist */}
                {activeSug.param && (
                  <div className="w-36">
                    <label className="block text-xs text-foreground-faint mb-1">{activeSug.param.label}</label>
                    <input type="number" min={1} value={paramValue} onChange={e => setParamValue(e.target.value)} className={fieldCls} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        <div>
          <label className="block text-xs text-foreground-faint mb-1">{label}</label>
          <textarea value={text} onChange={e => setText(e.target.value)} rows={2} placeholder={placeholder} className={`${fieldCls} resize-none`} />
        </div>
        {error && <p className="text-xs text-warn">{error}</p>}
        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onClose} className="text-xs text-foreground-faint hover:text-foreground-muted transition px-3 py-1.5 rounded-lg border border-border">{labels.strafbuchAbbrechen}</button>
          <button type="submit" disabled={saving} className={`text-xs font-semibold text-white px-3 py-1.5 rounded-lg disabled:opacity-50 flex items-center gap-1 transition hover:opacity-90 ${submitClass}`}>{submitIcon}{saving ? "…" : submitLabel}</button>
        </div>
      </form>
    );
  }

  function PunishedBadge({ refId }: { refId: string }) {
    const record = strafeRecords.find(r => r.refId === refId);
    if (!record) return null;
    const aiJudged = record.judgedBy === "ai";
    return (
      <div className="mt-1.5 flex flex-col gap-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-warn border border-warn px-2 py-0.5 rounded-lg flex items-center gap-1">{labels.strafbuchStrafeBadge}{record.reason ? `: ${record.reason}` : ""}</span>
          {aiJudged && <span className="text-xs text-foreground-faint">{labels.strafbuchUrteilKI}</span>}
          <button type="button" onClick={() => handleUndo(refId)} className="text-xs text-foreground-faint underline hover:text-warn transition ml-auto">{labels.strafbuchRueckgaengig}</button>
        </div>
        {/* Meldung des Subs hat Vorrang: sie verlangt eine Entscheidung (bestätigen/ablehnen). */}
        {!record.done && record.gemeldetAtStr ? (
          <CompletionReport record={record} />
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
            {record.done ? (
              <>
                <span className="text-xs font-semibold text-[var(--color-ok)] border border-[var(--color-ok)] px-2 py-0.5 rounded-lg flex items-center gap-1"><CheckCircle size={10} /> {labels.strafbuchErledigtBadge} {record.erledigtAtStr}</span>
                <button type="button" onClick={() => markDone(refId, false)} className="text-xs text-foreground-faint underline hover:text-warn transition">{labels.strafbuchWiederOffen}</button>
              </>
            ) : (
              <>
                <button type="button" onClick={() => markDone(refId, true)} className="text-xs font-medium text-[var(--color-ok)] border border-[var(--color-ok)] bg-[color-mix(in_srgb,var(--color-ok)_8%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-ok)_15%,transparent)] transition px-2.5 py-1 rounded-lg flex items-center gap-1"><CheckCircle size={11} /> {labels.strafbuchAlsErledigt}</button>
                {record.ablehnungGrund && (
                  <span className="text-xs text-warn italic">{labels.strafbuchAbgelehntBadge}: „{record.ablehnungGrund}"</span>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  function DismissedBadge({ refId }: { refId: string }) {
    const record = strafeRecords.find(r => r.refId === refId);
    if (!record) return null;
    const aiJudged = record.judgedBy === "ai";
    return (
      <div className="mt-1.5 flex items-center gap-2 flex-wrap">
        <span className="text-xs font-semibold text-foreground-faint border border-border px-2 py-0.5 rounded-lg flex items-center gap-1"><XCircle size={10} /> {labels.strafbuchVerworfenBadge}</span>
        {aiJudged && <span className="text-xs text-foreground-faint">{labels.strafbuchUrteilKI}</span>}
        {record.reason && <span className="text-xs text-foreground-faint italic">„{record.reason}"</span>}
        <button type="button" onClick={() => handleUndo(refId)} className="text-xs text-foreground-faint underline hover:text-warn transition ml-auto">{labels.strafbuchRueckgaengig}</button>
      </div>
    );
  }

  function JudgmentSlot({ row }: { row: OffenseRow }) {
    if (punishedIds.has(row.refId)) return <PunishedBadge refId={row.refId} />;
    if (dismissedIds.has(row.refId)) return <DismissedBadge refId={row.refId} />;
    // Auto-Vergehen ohne Record (theoretischer Fall) → nur Rückgängig unnötig; zeige Aktionen.
    const bestrafenOpen = openFormId === row.refId;
    const verwerfenOpen = openDismissId === row.refId;
    return (
      <div className="mt-2 flex flex-col gap-2">
        <div className="flex flex-wrap items-start gap-2">
          <button type="button" onClick={() => { setOpenFormId(bestrafenOpen ? null : row.refId); setOpenDismissId(null); }}
            className="text-xs font-medium text-[var(--color-ok)] border border-[var(--color-ok)] bg-[color-mix(in_srgb,var(--color-ok)_8%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-ok)_15%,transparent)] transition px-2.5 py-1 rounded-lg flex items-center gap-1">
            <CheckCircle size={11} /> {labels.strafbuchWurdeBestraft}
            <ChevronDown size={11} className={`transition-transform ${bestrafenOpen ? "rotate-180" : ""}`} />
          </button>
          <button type="button" onClick={() => { setOpenDismissId(verwerfenOpen ? null : row.refId); setOpenFormId(null); }}
            className="text-xs font-medium text-foreground-faint border border-border hover:bg-surface-raised transition px-2.5 py-1 rounded-lg flex items-center gap-1">
            <XCircle size={11} /> {labels.strafbuchVerwerfen}
            <ChevronDown size={11} className={`transition-transform ${verwerfenOpen ? "rotate-180" : ""}`} />
          </button>
        </div>
        {bestrafenOpen && (
          <JudgmentForm refId={row.refId} offenseType={row.offenseType} status="PUNISHED"
            label={labels.strafbuchStrafeLabel} placeholder={labels.strafbuchStrafePlaceholder}
            submitLabel={labels.strafbuchStrafeVerhaengen} submitIcon={<CheckCircle size={12} />}
            submitClass="bg-[var(--color-ok)]" onClose={() => setOpenFormId(null)}
            penaltySuggestions={suggestions[row.severity]} />
        )}
        {verwerfenOpen && (
          <JudgmentForm refId={row.refId} offenseType={row.offenseType} status="DISMISSED"
            label={labels.strafbuchBegruendung}
            submitLabel={labels.strafbuchVerwerfen} submitIcon={<XCircle size={12} />}
            submitClass="bg-foreground-faint" onClose={() => setOpenDismissId(null)} />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Schwere-Übersicht / Legende — Hilfestellung */}
      <div className="bg-surface rounded-2xl border border-border overflow-hidden">
        <button type="button" onClick={() => setShowLegend(v => !v)}
          className="w-full px-5 py-3 flex items-center justify-between text-left hover:bg-background-hover transition">
          <span className="text-xs font-semibold uppercase tracking-wider text-foreground-faint">{labels.strafbuchLegende}</span>
          <ChevronDown size={16} className={`text-foreground-faint transition-transform ${showLegend ? "rotate-180" : ""}`} />
        </button>
        {showLegend && (
          <div className="px-5 pb-4 pt-1 flex flex-col gap-3 border-t border-border-subtle">
            {matrix.map((row) => (
              <div key={row.severity} className="flex flex-col gap-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-[0.65rem] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${SEV_STYLE[row.severity]}`}>{sevLabel[row.severity]}</span>
                  <span className="text-xs text-foreground-faint">{row.offenses.join(" · ")}</span>
                </div>
                <ul className="ml-1 flex flex-col gap-0.5">
                  {row.suggestions.map((s, i) => (
                    <li key={i} className="text-xs text-foreground-muted">• {s}</li>
                  ))}
                </ul>
              </div>
            ))}
            <p className="text-xs text-foreground-faint italic">{labels.strafbuchLegendeHint}</p>
          </div>
        )}
      </div>

      {!hasAny && (
        <div className="bg-surface rounded-2xl border border-border py-20 text-center text-foreground-faint text-sm">{labels.strafbuchNoEntries}</div>
      )}
      {hasAny && display.length === 0 && (
        <div className="bg-surface rounded-2xl border border-border py-20 text-center text-foreground-faint text-sm">{labels.strafbuchAlleVergehenBestraft}</div>
      )}

      {display.length > 0 && (
        <div className="bg-surface rounded-2xl border border-border overflow-hidden">
          <div className="px-5 py-3 border-b border-border-subtle flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wider text-foreground-faint">{labels.strafbuchVergehen}</p>
            <span className="text-xs tabular-nums text-foreground-faint">
              {hasClosed
                ? <><span className="font-semibold">{openOffenses.length} {labels.strafbuchOffen}</span><span className="opacity-50"> / {offenses.length} {labels.strafbuchGesamt}</span></>
                : <span className="font-semibold">{offenses.length}</span>}
            </span>
          </div>
          <div className="divide-y divide-border-subtle">
            {display.map((o) => {
              const judged = closedIds.has(o.refId);
              return (
                <div key={`${o.offenseType}-${o.refId}`} className={`px-5 py-3 flex flex-col gap-0.5 ${judged ? "opacity-50" : ""}`}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-[0.65rem] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${SEV_STYLE[o.severity]}`}>{sevLabel[o.severity]}</span>
                    {o.escalated && (
                      <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-warn border border-warn px-1.5 py-0.5 rounded">↑ {labels.strafbuchHochgestuft}</span>
                    )}
                    <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-foreground-faint bg-background-subtle px-1.5 py-0.5 rounded">{o.typeLabel}</span>
                  </div>
                  <p className={`text-sm font-semibold text-foreground ${judged ? "line-through" : ""}`}>{o.headline}</p>
                  {o.detail && <p className="text-xs text-foreground-faint">{o.detail}</p>}
                  {o.note && <span className="text-xs text-foreground-faint italic">„{o.note}"</span>}
                  <JudgmentSlot row={o} />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {hasClosed && (
        <button type="button" onClick={() => setShowAll(v => !v)}
          className="w-full text-xs text-foreground-faint hover:text-foreground-muted transition border border-border rounded-xl px-3 py-2.5">
          {showAll ? labels.strafbuchOffeneAnzeigen : labels.strafbuchAlleAnzeigen}
        </button>
      )}
    </div>
  );
}
