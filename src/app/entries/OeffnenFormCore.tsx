"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AlertCircle, Lock, LockOpen } from "lucide-react";
import { toDatetimeLocal, fromDatetimeLocal, toDateLocale } from "@/lib/utils";
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
import type { OeffnenPayload, ReinigungConfig, ToiletteConfig, SperrzeitState, SubmitResult } from "./types";

interface Props {
  initial?: { startTime: string; note?: string | null; oeffnenGrund?: string | null };
  /** Owner-scoped, display-ready opening reasons (built-in defaults when the owner has no custom config).
   *  REINIGUNG + TOILETTE are excluded in create mode (replaced by PAUSE_BEGIN/END flow);
   *  they remain selectable in edit mode for backward compatibility with existing entries. */
  grundOptions: ResolvedReason[];
  maxTime?: string;
  tz: string;
  nowDefault: string;
  sperrzeit?: SperrzeitState;
  reinigung?: ReinigungConfig;
  toilette?: ToiletteConfig;
  isEdit?: boolean;
  submitFn: (payload: OeffnenPayload) => Promise<SubmitResult>;
  onSuccess?: () => void;
  onCancel?: () => void;
  submitVariant?: "semantic" | "primary";
  submitLabel?: string;
  defaultGrund?: OeffnenGrund;
}

export default function OeffnenFormCore({
  initial, grundOptions, maxTime, tz, nowDefault, sperrzeit, reinigung, toilette,
  isEdit = false, submitFn, onSuccess, onCancel, submitVariant = "semantic", submitLabel, defaultGrund,
}: Props) {
  const t = useTranslations("openForm");
  const tCommon = useTranslations("common");
  const dl = toDateLocale(useLocale());

  const sperrzeitEndetAt = sperrzeit?.endetAt ?? null;
  const sperrzeitUnbefristet = sperrzeit?.unbefristet ?? false;
  const sperrzeitReinigungErlaubt = sperrzeit?.reinigungErlaubt ?? false;
  const sperrzeitToiletteErlaubt = sperrzeit?.toiletteErlaubt ?? false;
  const reinigungErlaubt = reinigung?.erlaubt ?? false;
  const reinigungMaxMinuten = reinigung?.maxMinuten ?? 15;
  const toiletteErlaubt = toilette?.erlaubt ?? false;
  const toiletteMaxMinuten = toilette?.maxMinuten ?? 15;

  const [startTime, setStartTime] = useState(toDatetimeLocal(initial?.startTime, tz) || nowDefault);
  const [grund, setGrund] = useState<OeffnenGrund | "">((initial?.oeffnenGrund as OeffnenGrund) ?? defaultGrund ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const [showWarning, setShowWarning] = useState(false);
  const { saving, error, setError, submit } = useEntrySubmit<OeffnenPayload>(submitFn, onSuccess);

  const isGesperrt = sperrzeitUnbefristet || !!(sperrzeitEndetAt && new Date(sperrzeitEndetAt) > new Date());
  // REINIGUNG/TOILETTE-Öffnungen verletzen die Sperre NICHT, wenn beide Seiten es erlauben.
  const istErlaubteReinigungsOeffnung = grund === "REINIGUNG" && reinigungErlaubt && sperrzeitReinigungErlaubt;
  const istErlaubteToiletteOeffnung = grund === "TOILETTE" && toiletteErlaubt && sperrzeitToiletteErlaubt;
  const isGesperrtBlockiert = isGesperrt && !istErlaubteReinigungsOeffnung && !istErlaubteToiletteOeffnung;

  async function doSave() {
    await submit({
      type: "OEFFNEN",
      startTime: fromDatetimeLocal(startTime, tz).toISOString(),
      oeffnenGrund: grund,
      note: note.trim() || null,
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!grund) { setError(t("grundRequired")); return; }
    if (!note.trim()) { setError(t("commentRequired")); return; }
    if (isGesperrtBlockiert) { setShowWarning(true); return; }
    await doSave();
  }

  // REINIGUNG + TOILETTE are removed from create-mode (replaced by PAUSE_BEGIN/END flow).
  // In edit mode they remain selectable for backward compat with existing entries.
  const HIDDEN_IN_CREATE = new Set(["REINIGUNG", "TOILETTE"]);
  const grundSelectOptions = grundOptions
    .filter((r) => isEdit || !HIDDEN_IN_CREATE.has(r.code))
    .map((r) => ({ value: r.code, label: r.label }));
  // Bestandswert erhalten: ein entfernter/umbenannter Grund (nicht mehr in der Liste) wird als Option
  // ergänzt, damit ein reiner Zeit-Edit nicht an einem fehlenden Match scheitert.
  if (initial?.oeffnenGrund && !grundSelectOptions.some((o) => o.value === initial.oeffnenGrund)) {
    grundSelectOptions.push({ value: initial.oeffnenGrund, label: initial.oeffnenGrund });
  }

  const defaultLabel = isEdit ? tCommon("update") : t("saveBtn");

  return (
    <>
      <Sheet open={showWarning} onClose={() => setShowWarning(false)} title="">
        <div className="flex flex-col gap-5">
          <div className="flex items-start gap-3">
            <AlertCircle size={28} className="flex-shrink-0 text-warn mt-0.5" />
            <div className="flex flex-col gap-1.5">
              <p className="font-bold text-foreground text-base leading-snug">
                {grund === "REINIGUNG" ? t("modalTitleReinigung") : grund === "TOILETTE" ? t("modalTitleToilette") : t("modalTitle")}
              </p>
              <p className="text-sm text-foreground-muted">
                {grund === "REINIGUNG" && reinigungErlaubt
                  ? t("modalSubtextReinigung", { minutes: reinigungMaxMinuten })
                  : grund === "REINIGUNG"
                    ? t("reinigungHintNoConfig")
                    : grund === "TOILETTE" && toiletteErlaubt
                      ? t("toiletteHint", { minutes: toiletteMaxMinuten })
                      : grund === "TOILETTE"
                        ? t("toiletteHintNoConfig")
                        : t("modalSubtext")}
              </p>
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
              {t("modalOpenAnyway")}
            </Button>
          </div>
        </div>
      </Sheet>

      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <RequiredHint />

        {isGesperrtBlockiert && (
          <Card variant="semantic" semantic="sperrzeit">
            <div className="flex items-start gap-2.5">
              <Lock size={16} className="flex-shrink-0 text-sperrzeit mt-0.5" />
              <div>
                <p className="text-sm font-bold text-sperrzeit-text">{t("lockedWarningTitle")}</p>
                <p className="text-xs text-sperrzeit mt-0.5">
                  {sperrzeitUnbefristet
                    ? t("lockedWarningTextIndefinite")
                    : t("lockedWarningText", { date: new Date(sperrzeitEndetAt!).toLocaleString(dl, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: tz }) })}
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
          {...(maxTime && { max: maxTime })}
        />

        <Select
          label={t("grundLabel")}
          value={grund}
          onChange={(e) => { setGrund(e.target.value as OeffnenGrund | ""); if (e.target.value) setError(""); }}
          required
          placeholder="–"
          options={grundSelectOptions}
        />

        {grund === "REINIGUNG" && (
          <Card variant="semantic" semantic="inspect" padding="compact">
            <p className="text-xs text-inspect-text">
              {reinigungErlaubt
                ? t("modalSubtextReinigung", { minutes: reinigungMaxMinuten })
                : t("reinigungHintNoConfig")}
            </p>
          </Card>
        )}

        {grund === "TOILETTE" && (
          <Card variant="semantic" semantic="inspect" padding="compact">
            <p className="text-xs text-inspect-text">
              {toiletteErlaubt
                ? t("toiletteHint", { minutes: toiletteMaxMinuten })
                : t("toiletteHintNoConfig")}
            </p>
          </Card>
        )}

        <Textarea
          label={tCommon("comment")}
          value={note}
          onChange={(e) => { setNote(e.target.value); if (e.target.value.trim()) setError(""); }}
          rows={4}
          required
          placeholder={t("commentPlaceholder")}
        />

        <FormError message={error} />

        <div className="flex flex-col-reverse sm:flex-row gap-3 pt-1">
          {onCancel && (
            <Button type="button" variant="secondary" fullWidth onClick={onCancel}>
              {tCommon("cancel")}
            </Button>
          )}
          <Button
            type="submit"
            variant={submitVariant}
            semantic={submitVariant === "semantic" ? "unlock" : undefined}
            fullWidth
            loading={saving}
            icon={submitVariant === "primary" ? <LockOpen size={16} /> : undefined}
          >
            {submitLabel ?? defaultLabel}
          </Button>
        </div>
      </form>
    </>
  );
}
