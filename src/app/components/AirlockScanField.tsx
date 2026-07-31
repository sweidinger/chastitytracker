"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Nfc, Check } from "lucide-react";
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
 * Airlock-NFC — geteilter Scan-Block für Verschluss- und Kontroll-Formular. Kapselt Verfügbarkeits-
 * Prüfung, den nativen Scan (nur iOS-App) und die Statusanzeige. Der eigentliche Echtheits-Check
 * passiert serverseitig beim Speichern (Weg A) — hier wird der rohe Nachweis nur eingesammelt.
 */
export default function AirlockScanField({ mode, assignedCode, value, onChange }: Props) {
  const t = useTranslations("airlockScan");
  const required = mode === "kontrolle";

  const [available, setAvailable] = useState<boolean | null>(null);
  const [scanning, setScanning] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    isNfcAvailable().then((a) => { if (!cancelled) setAvailable(a); });
    return () => { cancelled = true; };
  }, []);

  const scannedCode = value ? (parseNdef(value.ndefText)?.code ?? null) : null;

  async function handleScan() {
    setErr(null);
    setScanning(true);
    const r = await scanNfcTag(t("scanning"));
    setScanning(false);
    if (r.ok) {
      onChange({ uid: r.data.uid, ndefText: r.data.ndefText });
      return;
    }
    if (r.error === "NFC_CANCELLED") return; // stiller Abbruch — kein Fehler zeigen
    setErr(r.error === "not-native" ? t("notAvailable") : t("errGeneric"));
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
            <span className="inline-flex items-center gap-1.5 text-sm text-ok-text font-medium">
              <Check size={15} /> {t("scanned", { code: scannedCode ?? "?" })}
            </span>
            <Button type="button" variant="ghost" size="sm" onClick={() => { onChange(null); setErr(null); }}>
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
        {value && <p className="text-xs text-foreground-faint">{t("willVerify")}</p>}
      </div>
    </Card>
  );
}
