"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Dices } from "lucide-react";
import Card from "@/app/components/Card";
import Button from "@/app/components/Button";
import Select from "@/app/components/Select";
import EmptyState from "@/app/components/EmptyState";
import { hapticMedium } from "@/lib/haptics";

interface Pool {
  id: string;
  name: string;
}

/** Alle Tuning-Zahlen der Spin-Animation an EINER Stelle (keine verstreuten Magic Numbers). */
const SPIN = {
  /** Mindestdauer der Animation, auch wenn die Antwort früher da ist. */
  durationMs: 1600,
  /** Wie oft das „Rad" während des Drehens weiterspringt. */
  tickMs: 80,
  /** Platzhalter-Symbole, die während des Drehens durchlaufen — die echten Optionen (und ihre
   *  Gewichte) bleiben verborgen, bis das Ergebnis feststeht. */
  faces: ["🎲", "🔒", "🎁", "💧", "⏱️", "❓", "⭐️", "🔓"],
} as const;

export default function ZufallsRad({ pools }: { pools: Pool[] }) {
  const t = useTranslations("zufall");
  const [poolId, setPoolId] = useState(pools[0]?.id ?? "");
  const [spinning, setSpinning] = useState(false);
  const [face, setFace] = useState<string>(SPIN.faces[0]);
  const [result, setResult] = useState<{ optionLabel: string; outcomeType: string } | null>(null);
  const [error, setError] = useState(false);
  const busy = useRef(false);

  if (pools.length === 0) {
    return (
      <Card>
        <EmptyState icon={<Dices size={28} />} title={t("noPools")} />
      </Card>
    );
  }

  async function spin() {
    if (!poolId || busy.current) return;
    busy.current = true;
    setSpinning(true);
    setResult(null);
    setError(false);
    const started = Date.now();
    const iv = setInterval(() => setFace(SPIN.faces[Math.floor(Math.random() * SPIN.faces.length)]), SPIN.tickMs);

    let ok = false;
    let data: { optionLabel?: string; outcomeType?: string } | null = null;
    try {
      const res = await fetch("/api/zufall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolId }),
      });
      ok = res.ok;
      data = await res.json().catch(() => null);
    } catch {
      ok = false;
    }

    const elapsed = Date.now() - started;
    if (elapsed < SPIN.durationMs) await new Promise((r) => setTimeout(r, SPIN.durationMs - elapsed));
    clearInterval(iv);
    setSpinning(false);
    busy.current = false;

    if (ok && data?.optionLabel) {
      setResult({ optionLabel: data.optionLabel, outcomeType: data.outcomeType ?? "NOTHING" });
      hapticMedium();
    } else {
      setError(true);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {pools.length > 1 && (
        <Select
          label={t("selectPool")}
          value={poolId}
          onChange={(e) => setPoolId(e.target.value)}
          disabled={spinning}
          options={pools.map((p) => ({ value: p.id, label: p.name }))}
        />
      )}

      <Card className="flex flex-col items-center gap-5 py-8">
        {/* Rad / Reel */}
        <div
          className={`flex items-center justify-center size-32 rounded-full border-4 border-[var(--color-sperrzeit-border)] bg-sperrzeit-bg text-5xl select-none transition-transform ${spinning ? "animate-pulse" : ""}`}
          aria-live="polite"
        >
          {result ? <span className="text-2xl font-semibold text-center px-2 leading-tight">🎯</span> : <span>{face}</span>}
        </div>

        {result ? (
          <div className="text-center">
            <p className="text-xs font-semibold uppercase tracking-wider text-foreground-faint">{t("resultTitle")}</p>
            <p className="text-lg font-bold text-foreground mt-1">{result.optionLabel}</p>
            <p className="text-sm text-foreground-faint mt-1">{t(`outcomes.${result.outcomeType}` as `outcomes.${string}`)}</p>
            <p className="text-xs text-foreground-faint mt-2">{t("resultHint")}</p>
          </div>
        ) : (
          <p className="text-sm text-foreground-faint">{spinning ? t("spinning") : " "}</p>
        )}

        {error && <p className="text-sm text-warn">{t("error")}</p>}

        <Button semantic="sperrzeit" variant="semantic" size="lg" fullWidth loading={spinning} onClick={spin} icon={<Dices size={20} />}>
          {result ? t("again") : t("spin")}
        </Button>
      </Card>
    </div>
  );
}
