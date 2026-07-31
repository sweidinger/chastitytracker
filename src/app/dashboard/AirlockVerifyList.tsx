"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Nfc, Check, X } from "lucide-react";
import Card from "@/app/components/Card";
import Button from "@/app/components/Button";
import { scanNfcTag } from "@/lib/nfc";

interface Item { code: string; verified: boolean; }
interface RowState { verified: boolean; busy: boolean; err: string | null; }

/**
 * Liste der zugewiesenen Airlock-Schlösser mit Verifizierungs-Status. Pro unverifiziertem Schloss ein
 * Scan-Button: liest den Tag, ruft /api/airlock/verify (mode="verify") → bei Erfolg (echt + gehört dem
 * Sub + UID passt) wird das Schloss serverseitig als verifiziert markiert und hier grün gesetzt.
 */
export default function AirlockVerifyList({ items }: { items: Item[] }) {
  const t = useTranslations("airlockVerify");
  const tErr = useTranslations("errors");
  const [rows, setRows] = useState<Record<string, RowState>>(
    Object.fromEntries(items.map((i) => [i.code, { verified: i.verified, busy: false, err: null }])),
  );

  if (items.length === 0) return <p className="text-sm text-foreground-muted">{t("none")}</p>;

  async function verify(code: string) {
    setRows((s) => ({ ...s, [code]: { ...s[code], busy: true, err: null } }));
    const r = await scanNfcTag(t("scanning"));
    if (!r.ok) {
      if (r.error === "NFC_CANCELLED") { setRows((s) => ({ ...s, [code]: { ...s[code], busy: false } })); return; }
      const err = r.error === "not-native" ? t("notNative") : tErr("AIRLOCK_TAG_INVALID");
      setRows((s) => ({ ...s, [code]: { ...s[code], busy: false, err } }));
      return;
    }
    try {
      const res = await fetch("/api/airlock/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid: r.data.uid, ndefText: r.data.ndefText, mode: "verify" }),
      });
      const data = (await res.json()) as { ok: boolean; code?: string; error?: string };
      if (data.ok && data.code === code) {
        setRows((s) => ({ ...s, [code]: { verified: true, busy: false, err: null } }));
      } else {
        const err = data.ok ? t("wrongLockForRow", { code: data.code ?? "?" }) : tErr(data.error ?? "AIRLOCK_TAG_INVALID");
        setRows((s) => ({ ...s, [code]: { ...s[code], busy: false, err } }));
      }
    } catch {
      setRows((s) => ({ ...s, [code]: { ...s[code], busy: false, err: tErr("AIRLOCK_NOT_REACHABLE") } }));
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {items.map((i) => {
        const st = rows[i.code];
        return (
          <Card key={i.code} variant="semantic" semantic={st.verified ? "lock" : "inspect"} padding="compact">
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-semibold text-foreground">#{i.code}</span>
                {st.verified ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-ok-text font-medium"><Check size={14} /> {t("verified")}</span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-xs text-warn font-medium"><X size={14} /> {t("unverified")}</span>
                )}
                {st.err && <span className="text-xs text-warn">{st.err}</span>}
              </div>
              {!st.verified && (
                <Button type="button" variant="secondary" size="sm" loading={st.busy} onClick={() => verify(i.code)} icon={<Nfc size={15} />}>
                  {t("verifyBtn")}
                </Button>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
