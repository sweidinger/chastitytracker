"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";

interface TagesformEntry {
  id: string;
  erregung: number;
  koerper: number;
  headspace: number;
  notiz: string | null;
}

const DIMS = [
  { key: "erregung" as const, emoji: "🔥", labelKey: "erregungLabel" },
  { key: "koerper" as const, emoji: "💪", labelKey: "koerperLabel" },
  { key: "headspace" as const, emoji: "🧠", labelKey: "headspaceLabel" },
];

function DotPicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex gap-1.5">
      {[1, 2, 3, 4, 5].map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={`w-7 h-7 rounded-full border-2 transition-all text-xs font-bold
            ${v <= value
              ? "bg-lock border-lock text-white"
              : "bg-surface border-border text-foreground-faint hover:border-foreground-muted"
            }`}
        >
          {v}
        </button>
      ))}
    </div>
  );
}

function DotDisplay({ value, emoji }: { value: number; emoji: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-base">{emoji}</span>
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((v) => (
          <div
            key={v}
            className={`w-3 h-3 rounded-full transition-colors ${v <= value ? "bg-lock" : "bg-border"}`}
          />
        ))}
      </div>
    </div>
  );
}

export default function TagesformWidget() {
  const t = useTranslations("tagesform");
  const [entry, setEntry] = useState<TagesformEntry | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [values, setValues] = useState({ erregung: 3, koerper: 3, headspace: 3 });
  const [notiz, setNotiz] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/tagesform");
    const data = res.ok ? await res.json() : null;
    setEntry(data);
    if (data) {
      setValues({ erregung: data.erregung, koerper: data.koerper, headspace: data.headspace });
      setNotiz(data.notiz ?? "");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/tagesform", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, notiz: notiz || null }),
      });
      if (res.ok) {
        const data = await res.json();
        setEntry(data);
        setEditing(false);
      }
    } finally {
      setSaving(false);
    }
  }

  // Loading
  if (entry === undefined) return null;

  // Edit / create form
  if (editing || entry === null) {
    return (
      <div className="rounded-2xl border border-border bg-surface px-5 py-4 flex flex-col gap-3">
        <p className="text-sm font-bold text-foreground">{t("title")}</p>
        {DIMS.map(({ key, emoji, labelKey }) => (
          <div key={key} className="flex items-center gap-3">
            <span className="text-base w-6 text-center">{emoji}</span>
            <span className="text-xs text-foreground-muted w-28 flex-shrink-0">{t(labelKey)}</span>
            <DotPicker value={values[key]} onChange={(v) => setValues(prev => ({ ...prev, [key]: v }))} />
          </div>
        ))}
        <textarea
          value={notiz}
          onChange={(e) => setNotiz(e.target.value)}
          placeholder={t("notizPlaceholder")}
          className="text-sm bg-surface-raised border border-border rounded-xl px-3 py-2 text-foreground placeholder:text-foreground-faint resize-none h-16 mt-1"
        />
        <div className="flex gap-2 mt-1">
          <button
            onClick={save}
            disabled={saving}
            className="flex-1 text-sm font-semibold py-2 rounded-xl bg-lock text-white disabled:opacity-50 transition-opacity"
          >
            {saving ? t("saving") : t("save")}
          </button>
          {entry !== null && (
            <button
              onClick={() => { setEditing(false); setValues({ erregung: entry.erregung, koerper: entry.koerper, headspace: entry.headspace }); setNotiz(entry.notiz ?? ""); }}
              className="px-4 text-sm text-foreground-muted border border-border rounded-xl hover:bg-surface-raised transition-colors"
            >
              {t("cancel")}
            </button>
          )}
        </div>
      </div>
    );
  }

  // Display mode
  return (
    <div className="rounded-2xl border border-border bg-surface px-5 py-4 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-bold text-foreground">{t("title")}</p>
        <button
          onClick={() => setEditing(true)}
          className="text-xs text-foreground-faint hover:text-foreground-muted transition-colors"
        >
          {t("edit")}
        </button>
      </div>
      <div className="flex flex-col gap-1.5 mt-1">
        {DIMS.map(({ key, emoji, labelKey }) => (
          <div key={key} className="flex items-center gap-3">
            <DotDisplay value={entry[key]} emoji={emoji} />
            <span className="text-xs text-foreground-faint">{t(labelKey)}</span>
          </div>
        ))}
      </div>
      {entry.notiz && (
        <p className="text-xs text-foreground-muted mt-1 italic">{entry.notiz}</p>
      )}
    </div>
  );
}
