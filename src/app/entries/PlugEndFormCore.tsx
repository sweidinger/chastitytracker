"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AlertCircle, Lock } from "lucide-react";
import { toDateLocale, fromDatetimeLocal } from "@/lib/utils";
import { type OeffnenGrund } from "@/lib/constants";
import type { ResolvedReason } from "@/lib/reasonsService";
import { useEntrySubmit } from "@/app/hooks/useEntrySubmit";
import FormError from "@/app/components/FormError";
import RequiredHint from "@/app/components/RequiredHint";
import DateTimePicker from "@/app/components/DateTimePicker";
import Select from "@/app/components/Select";
import Textarea from "@/app/components/Textarea";
import Button from "@/app/components/Button";
import Card from "@/app/components/Card";
import Sheet from "@/app/components/Sheet";
import type { PlugEndPayload, ReinigungConfig, ToiletteConfig, SperrzeitState, SubmitResult } from "./types";

interface Props {
  deviceId: string;
  activeSession: { since: string; deviceName: string };
  /** Owner-scoped, display-ready reasons. Reinigung/Toilette laufen über die Pause-Funktion und
   *  werden hier nicht angeboten. */
  grundOptions: ResolvedReason[];
  tz: string;
  nowDefault: string;
  sperrzeit?: SperrzeitState;
  /** @deprecated Reinigung/Toilette laufen über die Pause-Funktion; hier nicht mehr genutzt. */
  reinigung?: ReinigungConfig;
  /** @deprecated wie oben. */
  toilette?: ToiletteConfig;
  submitFn: (payload: PlugEndPayload) => Promise<SubmitResult>;
  onSuccess?: () => void;
  onCancel?: () => void;
}

export default function PlugEndFormCore({
  deviceId, grundOptions, tz, nowDefault, sperrzeit,
  submitFn, onSuccess, onCancel,
}: Props) {
  const t = useTranslations("openForm");
  const tPlug = useTranslations("plugForm");
  const tCommon = useTranslations("common");
  const dl = toDateLocale(useLocale());

  const sperrzeitEndetAt = sperrzeit?.endetAt ?? null;
  const sperrzeitUnbefristet = sperrzeit?.unbefristet ?? false;

  const [startTime, setStartTime] = useState(nowDefault);
  const [grund, setGrund] = useState<OeffnenGrund | "">("");
  const [note, setNote] = useState("");
  const [showWarning, setShowWarning] = useState(false);
  const { saving, error, setError, submit } = useEntrySubmit<PlugEndPayload>(submitFn, onSuccess);

  const isGesperrt = sperrzeitUnbefristet || !!(sperrzeitEndetAt && new Date(sperrzeitEndetAt) > new Date());

  async function doSave() {
    await submit({
      type: "WEAR_END",
      startTime: fromDatetimeLocal(startTime, tz).toISOString(),
      deviceId,
      oeffnenGrund: grund,
      note: note.trim() || null,
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!grund) { setError(tPlug("grundRequired")); return; }
    if (!note.trim()) { setError(t("commentRequired")); return; }
    if (isGesperrt) { setShowWarning(true); return; }
    await doSave();
  }

  const grundSelectOptions = grundOptions.map((r) => ({ value: r.code, label: r.label }));

  return (
    <>
      <Sheet open={showWarning} onClose={() => setShowWarning(false)} title="">
        <div className="flex flex-col gap-5">
          <div className="flex items-start gap-3">
            <AlertCircle size={28} className="flex-shrink-0 text-warn mt-0.5" />
            <div className="flex flex-col gap-1.5">
              <p className="font-bold text-foreground text-base leading-snug">{t("modalTitle")}</p>
              <p className="text-sm text-foreground-muted">{tPlug("modalSubtext")}</p>
              <p className="text-xs text-sperrzeit font-semibold mt-1">
                {sperrzeitUnbefristet
                  ? t("modalLockedIndefinite")
                  : sperrzeitEndetAt
                    ? t("modalLockedUntil", { date: new Date(sperrzeitEndetAt).toLocaleString(dl, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: tz }) })
                    : null}
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Button variant="primary" fullWidth onClick={() => setShowWarning(false)}>
              {t("modalStay")}
            </Button>
            <Button variant="secondary" fullWidth loading={saving} onClick={() => { setShowWarning(false); doSave(); }}>
              {tPlug("modalRemoveAnyway")}
            </Button>
          </div>
        </div>
      </Sheet>

      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <RequiredHint />

        {isGesperrt && (
          <Card variant="semantic" semantic="sperrzeit">
            <div className="flex items-start gap-2.5">
              <Lock size={16} className="flex-shrink-0 text-sperrzeit mt-0.5" />
              <div>
                <p className="text-sm font-bold text-sperrzeit-text">{tPlug("lockedWarningTitle")}</p>
                <p className="text-xs text-sperrzeit mt-0.5">
                  {sperrzeitUnbefristet
                    ? tPlug("lockedWarningTextIndefinite")
                    : tPlug("lockedWarningText", { date: new Date(sperrzeitEndetAt!).toLocaleString(dl, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: tz }) })}
                </p>
              </div>
            </div>
          </Card>
        )}

        <DateTimePicker
          label={tCommon("dateTime")}
          value={startTime}
          onChange={(e) => setStartTime(e.target.value)}
          required
        />

        <Select
          label={tPlug("grundLabel")}
          value={grund}
          onChange={(e) => { setGrund(e.target.value as OeffnenGrund | ""); if (e.target.value) setError(""); }}
          required
          placeholder="–"
          options={grundSelectOptions}
        />

        <Textarea
          label={tCommon("comment")}
          value={note}
          onChange={(e) => { setNote(e.target.value); if (e.target.value.trim()) setError(""); }}
          rows={4}
          required
          placeholder={tPlug("commentPlaceholder")}
        />

        <FormError message={error} />

        <div className="flex flex-col-reverse sm:flex-row gap-3 pt-1">
          {onCancel && (
            <Button type="button" variant="secondary" fullWidth onClick={onCancel}>
              {tCommon("cancel")}
            </Button>
          )}
          <Button type="submit" variant="semantic" semantic="unlock" fullWidth loading={saving}>
            {tPlug("saveBtn")}
          </Button>
        </div>
      </form>
    </>
  );
}
