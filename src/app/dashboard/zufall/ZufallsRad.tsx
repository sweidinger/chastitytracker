"use client";

import { useEffect, useRef, useState } from "react";
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
  /** Mindestabstand zwischen zwei Ziehungen (Minuten); 0 = kein Cooldown. */
  cooldownMin: number;
  /** ISO-Zeitpunkt, ab dem wieder gezogen werden darf; null = jetzt erlaubt. */
  nextDrawAt: string | null;
}

interface HistoryItem {
  id: string;
  optionLabel: string;
  outcomeType: string;
  drawnAt: string;
  detail: string | null;
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

/** m:ss aus verbleibenden Millisekunden (auf ganze Sekunden aufgerundet). */
function formatRemaining(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function ZufallsRad({ pools, initialHistory = [] }: { pools: Pool[]; initialHistory?: HistoryItem[] }) {
  const t = useTranslations("zufall");
  const [poolId, setPoolId] = useState(pools[0]?.id ?? "");
  const [spinning, setSpinning] = useState(false);
  const [face, setFace] = useState<string>(SPIN.faces[0]);
  const [result, setResult] = useState<{ optionLabel: string; outcomeType: string; message: string | null } | null>(null);
  const [error, setError] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>(initialHistory);
  const busy = useRef(false);

  // Cooldown-Ende je Pool (ms-Timestamp | null). Aus den Server-Props initialisiert und nach jeder
  // eigenen Ziehung lokal fortgeschrieben, damit der Countdown sofort startet — ohne Refetch.
  const [nextDrawByPool, setNextDrawByPool] = useState<Record<string, number | null>>(() =>
    Object.fromEntries(pools.map((p) => [p.id, p.nextDrawAt ? new Date(p.nextDrawAt).getTime() : null])),
  );
  // Sekündlicher Tick, damit der Countdown läuft und der Button bei 0 wieder freigeschaltet wird.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);

  if (pools.length === 0) {
    return (
      <Card>
        <EmptyState icon={<Dices size={28} />} title={t("noPools")} />
      </Card>
    );
  }

  const selectedPool = pools.find((p) => p.id === poolId) ?? null;
  const nextAt = nextDrawByPool[poolId] ?? null;
  const remainingMs = nextAt ? Math.max(0, nextAt - nowMs) : 0;
  const cooling = remainingMs > 0;

  async function spin() {
    if (!poolId || busy.current || cooling) return;
    busy.current = true;
    setSpinning(true);
    setResult(null);
    setError(false);
    const started = Date.now();
    const iv = setInterval(() => setFace(SPIN.faces[Math.floor(Math.random() * SPIN.faces.length)]), SPIN.tickMs);

    let ok = false;
    let data: { ziehungId?: string; optionLabel?: string; outcomeType?: string; message?: string } | null = null;
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
      const outcomeType = data.outcomeType ?? "NOTHING";
      const message = data.message ?? null;
      setResult({ optionLabel: data.optionLabel, outcomeType, message });
      // Historie sofort lokal fortschreiben (Server-Reihenfolge = neueste zuerst).
      setHistory((h) => [
        { id: data!.ziehungId ?? `local-${started}`, optionLabel: data!.optionLabel!, outcomeType, drawnAt: new Date().toISOString(), detail: message },
        ...h,
      ].slice(0, 10));
      const cd = selectedPool?.cooldownMin ?? 0;
      if (cd > 0) setNextDrawByPool((prev) => ({ ...prev, [poolId]: Date.now() + cd * 60 * 1000 }));
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
            {result.message ? (
              <p className="text-sm text-foreground mt-2">{result.message}</p>
            ) : (
              <p className="text-xs text-foreground-faint mt-2">{t("resultHint")}</p>
            )}
          </div>
        ) : (
          <p className="text-sm text-foreground-faint">{spinning ? t("spinning") : " "}</p>
        )}

        {error && <p className="text-sm text-warn">{t("error")}</p>}

        {cooling && (
          <p className="text-sm font-medium text-foreground-faint tabular-nums" aria-live="polite">
            {t("cooldownActive", { time: formatRemaining(remainingMs) })}
          </p>
        )}

        <Button
          semantic="sperrzeit"
          variant="semantic"
          size="lg"
          fullWidth
          loading={spinning}
          disabled={cooling}
          onClick={spin}
          icon={<Dices size={20} />}
        >
          {result ? t("again") : t("spin")}
        </Button>
      </Card>

      {/* Ziehungs-Historie */}
      <Card className="flex flex-col gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-foreground-faint">{t("historyTitle")}</p>
        {history.length === 0 ? (
          <p className="text-sm text-foreground-faint">{t("historyEmpty")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle">
            {history.map((h) => (
              <li key={h.id} className="py-2 flex flex-col gap-0.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">{h.optionLabel}</span>
                  <span className="text-xs text-foreground-faint tabular-nums shrink-0">{new Date(h.drawnAt).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                </div>
                <span className="text-xs text-foreground-faint">
                  {t(`outcomes.${h.outcomeType}` as `outcomes.${string}`)}{h.detail ? ` — ${h.detail}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
