"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Nfc, Check, X, Loader2, AlertTriangle } from "lucide-react";
import Card from "@/app/components/Card";
import Button from "@/app/components/Button";
import { isNfcAvailable, scanNfcTag } from "@/lib/nfc";
import { parseNdef } from "@/lib/airlock/uid";

export interface AirlockProof {
  uid: string;
  ndefText: string;
}

interface Props {
  /** "verschluss" = optionaler Scan; "kontrolle" = erforderlicher Scan (Server erzwingt zusätzlich). */
  mode: "verschluss" | "kontrolle";
  /** Dem Sub zugewiesenes Lock (nur Anzeige, Verschluss-Fall). */
  assignedCode?: string | null;
  value: AirlockProof | null;
  onChange: (proof: AirlockProof | null) => void;
}

/**
 * Sofort-Verdikt nach dem Scan:
 *  - ok:         echt + (kontextabhängig) richtiges Lock.
 *  - bad:        serverseitig abgelehnt (Fehlercode aus dem "errors"-Namespace).
 *  - unreadable: der Tag lieferte keinen parsebaren AL1-Text — Diagnose-Zweig, zeigt das Rohgelesene.
 */
type Verdict =
  | { state: "ok"; code: string }
  | { state: "bad"; error: string }
  | { state: "unreadable"; raw: string }
  | null;

/** Kürzt das Rohgelesene für die Diagnose (kein voller Token im UI). */
function rawHint(raw: string): string {
  if (!raw) return "(leer)";
  const head = raw.slice(0, 16);
  return `„${head}${raw.length > 16 ? "…" : ""}" (${raw.length} Z.)`;
}

/**
 * Airlock-NFC — geteilter Scan-Block für Verschluss- und Kontroll-Formular. Kapselt Verfügbarkeits-
 * Prüfung, den nativen Scan (nur iOS-App) und die sofortige Echtheits-/Richtigkeits-Prüfung gegen die
 * Airlock-API (deckungsgleich mit dem Speichern, via `mode`). Der Server prüft beim Speichern
 * autoritativ erneut; dieses Verdikt ist die unmittelbare Rückmeldung für den Sub.
 */
export default function AirlockScanField({ mode, assignedCode, value, onChange }: Props) {
  const t = useTranslations("airlockScan");
  const tErr = useTranslations("errors");
  const required = mode === "kontrolle";

  const [available, setAvailable] = useState<boolean | null>(null);
  const [scanning, setScanning] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verdict, setVerdict] = useState<Verdict>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    isNfcAvailable().then((a) => { if (!cancelled) setAvailable(a); });
    return () => { cancelled = true; };
  }, []);

  const scannedCode = value ? (parseNdef(value.ndefText)?.code ?? null) : null;

  function reset() {
    onChange(null);
    setErr(null);
    setVerdict(null);
  }

  async function handleScan() {
    setErr(null);
    setVerdict(null);
    setScanning(true);
    const r = await scanNfcTag(t("scanning"));
    setScanning(false);
    if (!r.ok) {
      if (r.error === "NFC_CANCELLED") return; // stiller Abbruch
      setErr(r.error === "not-native" ? t("notAvailable") : t("errGeneric"));
      return;
    }
    const proof = { uid: r.data.uid, ndefText: r.data.ndefText };
    onChange(proof);

    // Kein lesbarer AL1-Inhalt → Diagnose-Zweig (zeigt das Rohgelesene), kein API-Call.
    if (!parseNdef(proof.ndefText)) {
      setVerdict({ state: "unreadable", raw: proof.ndefText });
      return;
    }

    // Sofort serverseitig verifizieren — deckungsgleich mit dem Speichern (mode).
    setVerifying(true);
    try {
      const res = await fetch("/api/airlock/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid: proof.uid, ndefText: proof.ndefText, mode }),
      });
      const data = (await res.json()) as { ok: boolean; code?: string; error?: string };
      setVerdict(
        data.ok
          ? { state: "ok", code: data.code ?? "?" }
          : { state: "bad", error: data.error ?? "AIRLOCK_TAG_INVALID" },
      );
    } catch {
      setVerdict({ state: "bad", error: "AIRLOCK_NOT_REACHABLE" });
    } finally {
      setVerifying(false);
    }
  }

  return (
    <Card variant="semantic" semantic={required ? "inspect" : "lock"} padding="compact">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Nfc size={16} className={required ? "text-inspect" : "text-lock"} />
          <p className="text-sm font-semibold text-foreground">{required ? t("titleRequired") : t("titleOptional")}</p>
        </div>

        {assignedCode && <p className="text-xs text-foreground-muted">{t("assignedLock", { code: assignedCode })}</p>}
        <p className="text-xs text-foreground-faint">{required ? t("requiredHint") : t("optionalHint")}</p>

        {value ? (
          <div className="flex items-center justify-between gap-2">
            {verifying ? (
              <span className="inline-flex items-center gap-1.5 text-sm text-foreground-muted">
                <Loader2 size={15} className="animate-spin" /> {t("verifying")}
              </span>
            ) : verdict?.state === "ok" ? (
              <span className="inline-flex items-center gap-1.5 text-sm text-ok-text font-medium">
                <Check size={15} /> {t("verifiedOk", { code: verdict.code })}
              </span>
            ) : verdict?.state === "bad" ? (
              <span className="inline-flex items-center gap-1.5 text-sm text-warn font-medium">
                <X size={15} /> {tErr(verdict.error)}
              </span>
            ) : verdict?.state === "unreadable" ? (
              <span className="inline-flex items-center gap-1.5 text-sm text-warn font-medium">
                <AlertTriangle size={15} /> {t("noAirlockData")} {rawHint(verdict.raw)}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-sm text-ok-text font-medium">
                <Check size={15} /> {t("scanned", { code: scannedCode ?? "?" })}
              </span>
            )}
            <Button type="button" variant="ghost" size="sm" onClick={reset}>
              {t("rescanBtn")}
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={scanning}
            disabled={available === false}
            onClick={handleScan}
            icon={<Nfc size={15} />}
          >
            {t("scanBtn")}
          </Button>
        )}

        {available === false && <p className="text-xs text-foreground-faint">{t("notAvailable")}</p>}
        {err && <p className="text-xs text-warn font-medium">{err}</p>}
      </div>
    </Card>
  );
}
