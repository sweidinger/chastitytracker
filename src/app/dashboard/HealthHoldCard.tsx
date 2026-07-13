"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { HeartPulse, X } from "lucide-react";
import Button from "@/app/components/Button";
import Textarea from "@/app/components/Textarea";
import FormError from "@/app/components/FormError";

export interface HealthHoldData {
  reason: string;
  since: string; // ISO
}

interface Props {
  initial: HealthHoldData | null;
  labels: {
    activeTitle: string;
    activeHint: string;
    since: string;
    end: string;
    trigger: string;
    triggerHint: string;
    reasonLabel: string;
    reasonPlaceholder: string;
    submit: string;
    cancel: string;
  };
}

/** Gesundheits-Stopp: der Sub kann jederzeit selbst eine Pause signalisieren. Ist er aktiv, stellt die
 *  AI-Keyholderin keine neuen Anforderungen mehr (serverseitig hart blockiert). */
export default function HealthHoldCard({ initial, labels }: Props) {
  const router = useRouter();
  const [hold, setHold] = useState<HealthHoldData | null>(initial);
  const [showForm, setShowForm] = useState(false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function start() {
    if (!reason.trim()) return;
    setSaving(true); setError("");
    try {
      const r = await fetch("/api/health-hold", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { setError(data.error ?? "Fehler"); }
      else {
        setHold({ reason: data.reason, since: new Date(data.since).toISOString() });
        setShowForm(false); setReason("");
        router.refresh();
      }
    } catch { setError("Netzwerkfehler"); }
    setSaving(false);
  }

  async function end() {
    setSaving(true); setError("");
    try {
      const r = await fetch("/api/health-hold", { method: "DELETE" });
      if (!r.ok) setError("Fehler");
      else { setHold(null); router.refresh(); }
    } catch { setError("Netzwerkfehler"); }
    setSaving(false);
  }

  // ── Aktiver Stopp: prominenter, ruhiger Banner ──
  if (hold) {
    return (
      <div className="w-full max-w-2xl mx-auto px-4 pt-4">
        <div className="rounded-2xl border border-warn-border bg-warn-bg px-5 py-4 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <HeartPulse size={16} className="text-warn shrink-0" />
            <p className="text-sm font-bold text-warn-text">{labels.activeTitle}</p>
          </div>
          <p className="text-sm text-warn">„{hold.reason}"</p>
          <p className="text-xs text-warn opacity-80">
            {labels.since} {new Date(hold.since).toLocaleString()}
          </p>
          <p className="text-xs text-warn opacity-80">{labels.activeHint}</p>
          <div>
            <button type="button" onClick={end} disabled={saving}
              className="mt-1 text-xs font-semibold px-3 py-1.5 rounded-lg border border-warn-border text-warn hover:opacity-80 transition disabled:opacity-40">
              {labels.end}
            </button>
          </div>
          {error && <p className="text-xs text-warn">{error}</p>}
        </div>
      </div>
    );
  }

  // ── Kein Stopp: dezenter Auslöser ──
  return (
    <div className="w-full max-w-2xl mx-auto px-4 pt-3">
      {!showForm ? (
        <button type="button" onClick={() => setShowForm(true)}
          className="flex items-center gap-1.5 text-xs text-foreground-faint hover:text-foreground-muted transition">
          <HeartPulse size={13} />
          {labels.trigger}
        </button>
      ) : (
        <div className="rounded-2xl border border-border bg-surface px-4 py-3 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <HeartPulse size={15} className="text-warn shrink-0" />
            <p className="text-sm font-semibold text-foreground">{labels.trigger}</p>
            <button type="button" onClick={() => { setShowForm(false); setError(""); }}
              className="ml-auto text-foreground-faint hover:text-foreground transition">
              <X size={15} />
            </button>
          </div>
          <p className="text-xs text-foreground-muted">{labels.triggerHint}</p>
          <Textarea
            label={labels.reasonLabel}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={labels.reasonPlaceholder}
            rows={2}
          />
          <FormError message={error} variant="compact" />
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" size="sm" onClick={() => { setShowForm(false); setError(""); }}>{labels.cancel}</Button>
            <Button size="sm" loading={saving} disabled={!reason.trim()} onClick={start}>{labels.submit}</Button>
          </div>
        </div>
      )}
    </div>
  );
}
