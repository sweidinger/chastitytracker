"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Droplets } from "lucide-react";
import { useTranslations } from "next-intl";
import { toDatetimeLocal, fromDatetimeLocal } from "@/lib/utils";
import { ORGASMUS_ANFORDERUNG_ARTEN, orgasmusAnforderungArtLabel } from "@/lib/constants";
import AdminActionFormShell from "@/app/components/AdminActionFormShell";
import DateTimePicker from "@/app/components/DateTimePicker";
import FormError from "@/app/components/FormError";
import Select from "@/app/components/Select";
import Textarea from "@/app/components/Textarea";
import Checkbox from "@/app/components/Checkbox";
import Button from "@/app/components/Button";
import { parseApiErrorCode } from "@/lib/apiClient";
import { useApiError } from "@/app/hooks/useApiError";

/** Kuratierte Art-Presets für „Orgasmus anfordern". Jedes Preset codiert Orgasmus-Art + ob geöffnet
 *  werden darf — dadurch entfällt eine separate „Öffnen erlaubt"-Checkbox. */
type ArtPreset = "orgasmus" | "ruiniert_verschlossen" | "ruiniert_offen";
const ART_PRESETS: Record<ArtPreset, { vorgegebeneArt: string; oeffnenErlaubt: boolean }> = {
  orgasmus: { vorgegebeneArt: "Orgasmus", oeffnenErlaubt: true },
  ruiniert_verschlossen: { vorgegebeneArt: "ruinierter Orgasmus", oeffnenErlaubt: false },
  ruiniert_offen: { vorgegebeneArt: "ruinierter Orgasmus", oeffnenErlaubt: true },
};

export default function OrgasmusAnforderungForm({ userId, tz, nowDefault }: { userId: string; tz: string; nowDefault: string }) {
  const t = useTranslations("admin");
  const tc = useTranslations("common");
  const apiError = useApiError();
  const router = useRouter();
  const target = `/admin/users/${userId}/aktionen`;

  const [art, setArt] = useState<(typeof ORGASMUS_ANFORDERUNG_ARTEN)[number]>("ANWEISUNG");
  const [beginntAt, setBeginntAt] = useState(nowDefault);
  const [endetAt, setEndetAt] = useState(() => toDatetimeLocal(new Date(fromDatetimeLocal(nowDefault, tz).getTime() + 24 * 60 * 60 * 1000), tz));
  const [artPreset, setArtPreset] = useState<ArtPreset>("orgasmus");
  const [belohnung, setBelohnung] = useState(false);
  const [istStrafe, setIstStrafe] = useState(false);
  const [fotoPflicht, setFotoPflicht] = useState(false);
  const [nachricht, setNachricht] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const modeOptions = ORGASMUS_ANFORDERUNG_ARTEN.map((a) => ({ value: a, label: orgasmusAnforderungArtLabel(a, t) }));
  const presetOptions: { value: ArtPreset; label: string }[] = [
    { value: "orgasmus", label: t("orgasmReqPresetOrgasmus") },
    { value: "ruiniert_verschlossen", label: t("orgasmReqPresetRuiniertClosed") },
    { value: "ruiniert_offen", label: t("orgasmReqPresetRuiniertOpen") },
  ];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (new Date(endetAt) <= new Date(beginntAt)) {
      setError(t("orgasmReqEndAfterStart"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      const body: Record<string, unknown> = belohnung
        ? {
            userId,
            belohnung: true,
            beginntAt: fromDatetimeLocal(beginntAt, tz).toISOString(),
            endetAt: fromDatetimeLocal(endetAt, tz).toISOString(),
            nachricht: nachricht.trim() || undefined,
            fotoPflicht,
          }
        : {
            userId,
            art,
            beginntAt: fromDatetimeLocal(beginntAt, tz).toISOString(),
            endetAt: fromDatetimeLocal(endetAt, tz).toISOString(),
            vorgegebeneArt: ART_PRESETS[artPreset].vorgegebeneArt,
            oeffnenErlaubt: ART_PRESETS[artPreset].oeffnenErlaubt,
            istStrafe: art === "ANWEISUNG" ? istStrafe : false,
            fotoPflicht,
            nachricht: nachricht.trim() || undefined,
          };
      const res = await fetch("/api/admin/orgasmus-anforderung", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) router.push(target);
      else setError(apiError(await parseApiErrorCode(res)));
    } catch {
      setError(tc("networkError"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <AdminActionFormShell
      userId={userId}
      backLabel={t("aktionen")}
      icon={<Droplets size={20} strokeWidth={2} />}
      iconBg="var(--color-orgasm-bg)"
      iconColor="var(--color-orgasm)"
      title={t("requestOrgasm")}
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {!belohnung && (
          <>
            <Select
              label={t("orgasmReqMode")}
              options={modeOptions}
              value={art}
              onChange={(e) => setArt(e.target.value as (typeof ORGASMUS_ANFORDERUNG_ARTEN)[number])}
            />
            <Select
              label={t("orgasmReqArt")}
              options={presetOptions}
              value={artPreset}
              onChange={(e) => setArtPreset(e.target.value as ArtPreset)}
            />
          </>
        )}
        <DateTimePicker label={t("orgasmReqStart")} value={beginntAt} onChange={(e) => setBeginntAt(e.target.value)} />
        <DateTimePicker label={t("orgasmReqEnd")} value={endetAt} onChange={(e) => setEndetAt(e.target.value)} />

        {/* Belohnung — wie „Belohnung gewähren": bucht 1 vom verdienten Guthaben ab. */}
        <div className="flex flex-col gap-1">
          <Checkbox
            label={t("orgasmReqBelohnungLabel")}
            checked={belohnung}
            onChange={(e) => setBelohnung(e.target.checked)}
          />
          <span className="text-xs text-foreground-faint pl-8">{t("orgasmReqBelohnungHint")}</span>
        </div>

        {!belohnung && art === "ANWEISUNG" && (
          <div className="flex flex-col gap-1">
            <Checkbox
              label={t("orgasmReqIstStrafeLabel")}
              checked={istStrafe}
              onChange={(e) => setIstStrafe(e.target.checked)}
            />
            <span className="text-xs text-foreground-faint pl-8">{t("orgasmReqIstStrafeHint")}</span>
          </div>
        )}
        {/* Foto-Nachweis: Pflicht beim Erfassen. Ohne Haken ist ein Foto freiwillig möglich. */}
        <div className="flex flex-col gap-1">
          <Checkbox
            label={t("orgasmReqFotoPflichtLabel")}
            checked={fotoPflicht}
            onChange={(e) => setFotoPflicht(e.target.checked)}
          />
          <span className="text-xs text-foreground-faint pl-8">{t("orgasmReqFotoPflichtHint")}</span>
        </div>

        <Textarea label={t("orgasmReqMessage")} value={nachricht} onChange={(e) => setNachricht(e.target.value)} rows={2} />

        <FormError message={error} variant="compact" />

        <Button type="submit" variant="semantic" semantic="orgasm" fullWidth loading={saving} icon={<Droplets size={16} />}>
          {saving ? t("sending") : t("orgasmReqSubmit")}
        </Button>
      </form>
    </AdminActionFormShell>
  );
}
