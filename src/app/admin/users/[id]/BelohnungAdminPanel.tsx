"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Gift } from "lucide-react";

export type BelohnbarZielData = {
  categoryId: string | null;
  categoryName: string;
  periodType: string;
  periodKey: string;
  istH: number;
  sollH: number;
};

export interface BelohnungAdminLabels {
  title: string;
  available: string;
  reserved: string;
  activeWindowUntil: string;
  grant: string;
  grantHint: string;
  credit: string;
  belohnbarTitle: string;
  none: string;
  periods: Record<string, string>; // day/week/month/year
  hoursUnit: string;
}

interface Props {
  userId: string;
  available: number;
  reserved: number;
  activeWindowEndetAt: string | null;
  belohnbar: BelohnbarZielData[];
  labels: BelohnungAdminLabels;
}

export default function BelohnungAdminPanel({ userId, available, reserved, activeWindowEndetAt, belohnbar, labels }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function grant() {
    setBusy("grant"); setError("");
    try {
      const r = await fetch("/api/admin/belohnung", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? "Fehler");
      else router.refresh();
    } catch { setError("Netzwerkfehler"); }
    setBusy(null);
  }

  async function credit(z: BelohnbarZielData) {
    const key = `${z.categoryId ?? ""}|${z.periodType}|${z.periodKey}`;
    setBusy(key); setError("");
    try {
      const r = await fetch("/api/admin/belohnung/gutschrift", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, categoryId: z.categoryId, periodType: z.periodType, periodKey: z.periodKey }),
      });
      if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? "Fehler");
      else router.refresh();
    } catch { setError("Netzwerkfehler"); }
    setBusy(null);
  }

  const canGrant = available >= 1 && !activeWindowEndetAt;

  return (
    <div className="bg-surface rounded-2xl border border-border p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Gift size={16} className="text-[var(--color-ok)]" />
        <span className="text-sm font-semibold text-foreground">{labels.title}</span>
        <span className="ml-auto text-xs text-foreground-muted">
          {labels.available}: <span className="font-semibold text-foreground">{available}</span>
          {reserved > 0 && <> · {labels.reserved}: <span className="font-semibold text-foreground">{reserved}</span></>}
        </span>
      </div>

      {activeWindowEndetAt && (
        <p className="text-xs text-foreground-muted">{labels.activeWindowUntil} {new Date(activeWindowEndetAt).toLocaleString()}</p>
      )}

      <div>
        <button type="button" onClick={grant} disabled={!canGrant || busy === "grant"}
          className="text-xs font-medium border rounded-lg px-3 py-1.5 transition disabled:opacity-40 disabled:cursor-not-allowed border-[var(--color-ok)] text-[var(--color-ok)] bg-[color-mix(in_srgb,var(--color-ok)_8%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-ok)_15%,transparent)]">
          {labels.grant}
        </button>
        {!canGrant && <span className="ml-2 text-xs text-foreground-faint">{labels.grantHint}</span>}
      </div>

      <div className="flex flex-col gap-1.5 border-t border-border-subtle pt-3">
        <p className="text-xs font-semibold text-foreground-faint">{labels.belohnbarTitle}</p>
        {belohnbar.length === 0 ? (
          <p className="text-xs text-foreground-faint italic">{labels.none}</p>
        ) : (
          belohnbar.map((z) => {
            const key = `${z.categoryId ?? ""}|${z.periodType}|${z.periodKey}`;
            return (
              <div key={key} className="flex items-center gap-2 text-xs">
                <span className="text-foreground-muted">
                  {z.categoryName} · {labels.periods[z.periodType] ?? z.periodType}: {z.istH.toFixed(1)}/{z.sollH.toFixed(1)} {labels.hoursUnit}
                </span>
                <button type="button" onClick={() => credit(z)} disabled={busy === key}
                  className="ml-auto border border-[var(--color-ok)] text-[var(--color-ok)] rounded-lg px-2 py-0.5 hover:bg-[color-mix(in_srgb,var(--color-ok)_12%,transparent)] transition disabled:opacity-40">
                  {labels.credit}
                </button>
              </div>
            );
          })
        )}
      </div>

      {error && <p className="text-xs text-warn">{error}</p>}
    </div>
  );
}
