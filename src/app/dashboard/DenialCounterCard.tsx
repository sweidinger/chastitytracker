"use client";

import { Hourglass } from "lucide-react";
import TimerDisplay from "@/app/components/TimerDisplay";

export interface DenialCounterLabels {
  title: string;
  since: string;
  noneYet: string;
}

interface Props {
  /** ISO-Zeitpunkt des letzten Orgasmus, oder null wenn noch keiner erfasst wurde. */
  lastOrgasmAt: string | null;
  /** Vorformatierte Budget-Zeile (serverseitig lokalisiert), oder null wenn kein Budget aktiv. */
  budgetLine?: string | null;
  labels: DenialCounterLabels;
}

/** Sub-Dashboard: Zeit seit dem letzten Orgasmus (Denial-Zaehler), live tickend, plus optional
 *  die Orgasmus-Budget-Zeile. Spiegelt die Struktur des BelohnungBanner (orgasm-Farbtoken). */
export default function DenialCounterCard({ lastOrgasmAt, budgetLine, labels }: Props) {
  return (
    <div className="w-full max-w-2xl mx-auto px-4 pt-4">
      <div className="rounded-2xl border border-[var(--color-orgasm)] bg-[color-mix(in_srgb,var(--color-orgasm)_8%,transparent)] px-5 py-4">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 bg-[color-mix(in_srgb,var(--color-orgasm)_15%,transparent)] text-[var(--color-orgasm)]">
            <Hourglass size={24} strokeWidth={2} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-orgasm)] opacity-80">{labels.title}</p>
            {lastOrgasmAt ? (
              <p className="text-sm text-foreground">
                <TimerDisplay targetDate={new Date(lastOrgasmAt)} mode="countup" format="long" className="font-bold text-foreground" />
                <span className="text-foreground-muted"> {labels.since}</span>
              </p>
            ) : (
              <p className="text-sm text-foreground-muted">{labels.noneYet}</p>
            )}
            {budgetLine && <p className="text-sm text-foreground-muted mt-0.5">{budgetLine}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
