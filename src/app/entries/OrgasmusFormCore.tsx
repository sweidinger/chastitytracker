"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Droplets } from "lucide-react";
import { toDatetimeLocal, fromDatetimeLocal } from "@/lib/utils";
import { splitOrgasmusArt, type OrgasmusOption } from "@/lib/reasonsService";
import FormError from "@/app/components/FormError";
import RequiredHint from "@/app/components/RequiredHint";
import PhotoCapture from "@/app/components/PhotoCapture";
import RotatableImagePreview from "@/app/components/RotatableImagePreview";
import Card from "@/app/components/Card";
import { usePhotoUpload } from "@/app/hooks/usePhotoUpload";
import DateTimePicker from "@/app/components/DateTimePicker";
import Select from "@/app/components/Select";
import Textarea from "@/app/components/Textarea";
import Button from "@/app/components/Button";
import EntryFormShell from "@/app/components/EntryFormShell";
import { useEntrySubmit } from "@/app/hooks/useEntrySubmit";
import type { OrgasmusPayload, SubmitResult } from "./types";

/** Leitet aus einem gespeicherten Wert (voller Kombi-Code ODER blanke Hauptart) die Auswahl ab. */
function initFromStored(stored: string | null | undefined, options: OrgasmusOption[]): { main: string; subCode: string } {
  const byCode = stored ? options.find((o) => o.code === stored) : undefined;
  if (byCode) return { main: byCode.mainToken, subCode: byCode.subLabel ? byCode.code : "" };
  const main = stored && options.some((o) => o.mainToken === stored) ? stored : (options[0]?.mainToken ?? "");
  return { main, subCode: "" };
}

interface Props {
  initial?: { startTime: string; note?: string | null; orgasmusArt?: string | null; imageUrl?: string | null };
  /** Owner-scoped Kaskaden-Optionen (Built-in-Defaults, wenn der Owner keine eigene Config hat). */
  artOptions: OrgasmusOption[];
  maxTime?: string;
  tz: string;
  nowDefault: string;
  isEdit?: boolean;
  submitFn: (payload: OrgasmusPayload) => Promise<SubmitResult>;
  onSuccess?: () => void;
  onCancel?: () => void;
  submitVariant?: "semantic" | "primary";
  submitLabel?: string;
  /** Offene Anforderung verlangt einen Foto-Nachweis → Foto ist Pflicht (sonst freiwillig). */
  fotoPflicht?: boolean;
  mobileDesktopMode?: boolean;
  /** Festgesetzte Haupt-Art (Haupt-Token). Gesetzt, wenn eine Anforderung sie vorgibt (z.B.
   *  „Belohnung" beim Einloesen einer Belohnungs-Gelegenheit) — dann ist das Art-Feld fix. */
  lockedArt?: string;
}

export default function OrgasmusFormCore({
  initial, artOptions, maxTime, tz, nowDefault, isEdit = false, submitFn, onSuccess, onCancel, submitVariant = "semantic", submitLabel,
  fotoPflicht = false, mobileDesktopMode, lockedArt,
}: Props) {
  const t = useTranslations("orgasmForm");
  const tc = useTranslations("common");
  // Bestandswert erhalten: matcht der gespeicherte Wert weder Code noch Hauptart (entfernte/umbenannte/
  // Legacy-Art wie „ruinierter Orgasmus – Verschlossen"), als synthetische Option einschleusen — sonst
  // fiele initFromStored auf die erste Hauptart zurück und Speichern überschriebe den erfassten Wert.
  const options = useMemo(() => {
    const stored = initial?.orgasmusArt;
    if (!stored || artOptions.some((o) => o.code === stored || o.mainToken === stored)) return artOptions;
    const { mainToken, subLabel } = splitOrgasmusArt(stored);
    const mainLabel = artOptions.find((o) => o.mainToken === mainToken)?.mainLabel ?? mainToken;
    return [...artOptions, { code: stored, mainToken, mainLabel, subLabel }];
  }, [artOptions, initial?.orgasmusArt]);
  const init = initFromStored(initial?.orgasmusArt, options);

  const [startTime, setStartTime] = useState(toDatetimeLocal(initial?.startTime, tz) || nowDefault);
  const [art, setArt] = useState(lockedArt ?? init.main); // Haupt-Token (fix, wenn lockedArt gesetzt)
  const [subCode, setSubCode] = useState(init.subCode); // voller Code der gewählten Unterart, "" = keine Angabe
  const [note, setNote] = useState(initial?.note ?? "");
  const { saving, error, submit } = useEntrySubmit<OrgasmusPayload>(submitFn, onSuccess);
  const [photoMissing, setPhotoMissing] = useState(false);

  const {
    imageUrl, imageExifTime, imagePreview,
    uploading, uploadError,
    rotation, rotateLeft, rotateRight,
    handleFile, clearPhoto,
  } = usePhotoUpload({ startTime, initial: { imageUrl: initial?.imageUrl ?? null } });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Foto-Pflicht kommt aus der offenen Anforderung — hier nur die freundliche Vorab-Prüfung,
    // die verbindliche Kontrolle macht der Server (/api/entries).
    if (fotoPflicht && !imageUrl) {
      setPhotoMissing(true);
      return;
    }
    setPhotoMissing(false);
    await submit({
      type: "ORGASMUS",
      startTime: fromDatetimeLocal(startTime, tz).toISOString(),
      // Unterart gewählt → deren voller Code; sonst nur die Hauptart (Haupt-Token).
      orgasmusArt: subCode || art,
      note: note.trim() || null,
      imageUrl: imageUrl || null,
      imageExifTime: imageExifTime || null,
    });
  }

  // Haupt-Dropdown: eindeutige Hauptarten in Listenreihenfolge.
  const mainOptions = options.reduce<{ value: string; label: string }[]>((acc, o) => {
    if (!acc.some((m) => m.value === o.mainToken)) acc.push({ value: o.mainToken, label: o.mainLabel });
    return acc;
  }, []);
  // Unterart-Dropdown: Einträge der gewählten Hauptart, die eine Unterart haben.
  const subArtOptions = options.filter((o) => o.mainToken === art && o.subLabel).map((o) => ({ value: o.code, label: o.subLabel }));
  const defaultLabel = isEdit ? tc("update") : t("saveBtn");

  return (
    <EntryFormShell
      onSubmit={handleSubmit}
      onCancel={onCancel}
      cancelLabel={tc("cancel")}
      actions={
        <Button
          type="submit"
          variant={submitVariant}
          semantic={submitVariant === "semantic" ? "orgasm" : undefined}
          fullWidth
          loading={saving}
          icon={submitVariant === "primary" ? <Droplets size={16} /> : undefined}
        >
          {submitLabel ?? defaultLabel}
        </Button>
      }
    >
      <RequiredHint />
      <DateTimePicker
        label={tc("dateTime")}
        value={startTime}
        onChange={(e) => setStartTime(e.target.value)}
        required
        {...(maxTime && { max: maxTime })}
      />

      <Select
        label={t("type")}
        value={art}
        onChange={(e) => { setArt(e.target.value); setSubCode(""); }}
        required
        disabled={!!lockedArt}
        options={mainOptions}
      />

      {subArtOptions.length > 0 && (
        <Select
          label={t("subType")}
          value={subCode}
          onChange={(e) => setSubCode(e.target.value)}
          placeholder={t("noSubType")}
          options={subArtOptions}
        />
      )}

      {/* Foto: freiwillig — Pflicht nur, wenn die Anforderung es verlangt. */}
      <Card padding="default">
        <p className="text-sm font-medium text-foreground mb-2">
          {fotoPflicht ? t("photoRequired") : t("photoOptional")}
          {fotoPflicht && <span className="text-warn ml-1">*</span>}
        </p>
        {imagePreview ? (
          <div className="flex items-start gap-4">
            <RotatableImagePreview
              src={imagePreview}
              rotation={rotation}
              onRotateLeft={rotateLeft}
              onRotateRight={rotateRight}
            />
            <div className="flex flex-col gap-2 flex-1 pt-1">
              <PhotoCapture onFile={handleFile} uploading={uploading} variant="orange" compact />
              <button type="button" onClick={clearPhoto} className="text-xs text-warn hover:opacity-80 w-fit transition">
                {tc("removePhoto")}
              </button>
            </div>
          </div>
        ) : (
          <>
            <PhotoCapture onFile={handleFile} uploading={uploading} variant="orange" mobileDesktopMode={mobileDesktopMode} />
            {uploadError && !uploading && <p className="text-xs text-warn font-medium mt-1">{uploadError}</p>}
          </>
        )}
        {photoMissing && !imageUrl && <p className="text-xs text-warn font-medium mt-2">{t("photoMissing")}</p>}
      </Card>

      <Textarea
        label={tc("commentOptional")}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={3}
      />

      <FormError message={error} />
    </EntryFormShell>
  );
}
