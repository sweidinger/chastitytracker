"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations, useLocale } from "next-intl";
import Card from "@/app/components/Card";
import DateTimePicker from "@/app/components/DateTimePicker";
import Textarea from "@/app/components/Textarea";
import Button from "@/app/components/Button";
import FormError from "@/app/components/FormError";
import PhotoCapture from "@/app/components/PhotoCapture";
import RotatableImagePreview from "@/app/components/RotatableImagePreview";
import useToast from "@/app/hooks/useToast";
import { usePhotoUpload } from "@/app/hooks/usePhotoUpload";
import { toDatetimeLocal, fromDatetimeLocal, formatElapsedMs } from "@/lib/utils";
import type { PauseDevice, PauseReasonOption } from "@/lib/pauseService";

interface Props {
  kind: "begin" | "end";
  device: PauseDevice;
  /** Erlaubte Pause-Gründe (Reinigung/Toilette) mit Limits — nur für die "begin"-Ansicht. */
  reasons?: PauseReasonOption[];
  /** ISO string of when the current pause started (END form only — shows elapsed duration). */
  activePauseSince?: string | null;
  tz: string;
  nowDefault: string;
  mobileDesktopMode?: boolean;
}

export default function PauseForm({ kind, device, reasons = [], activePauseSince, tz, nowDefault, mobileDesktopMode }: Props) {
  const t = useTranslations("pauseForm");
  const tCommon = useTranslations("common");
  const tOpen = useTranslations("openForm");
  const router = useRouter();
  const toast = useToast();
  const locale = useLocale();

  const [startTime, setStartTime] = useState(nowDefault);
  const [note, setNote] = useState("");
  const [grund, setGrund] = useState<"REINIGUNG" | "TOILETTE" | "">(reasons.length === 1 ? reasons[0].grund : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const showReasons = kind === "begin" && reasons.length > 0;
  const selectedReason = reasons.find((r) => r.grund === grund) ?? null;

  const {
    imageUrl, imageExifTime, imagePreview,
    uploading, uploadError,
    rotation, rotateLeft, rotateRight,
    handleFile, clearPhoto,
  } = usePhotoUpload({ startTime });

  const requirePhoto = kind === "end";

  // Show active pause duration on END form (static at mount — good enough for a form)
  const pauseElapsedMs = activePauseSince
    ? Math.max(0, Date.now() - new Date(activePauseSince).getTime())
    : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (requirePhoto && !imageUrl) {
      setError(t("photoRequired"));
      return;
    }
    if (showReasons && !grund) {
      setError(t("reasonRequired"));
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: kind === "begin" ? "PAUSE_BEGIN" : "PAUSE_END",
          pauseDevice: device,
          startTime: fromDatetimeLocal(startTime, tz).toISOString(),
          imageUrl: imageUrl || null,
          imageExifTime: imageExifTime || null,
          note: note.trim() || null,
          oeffnenGrund: kind === "begin" && grund ? grund : null,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.error || tCommon("savingError"));
        return;
      }
      toast.success(t(kind === "begin" ? "pauseStarted" : "pauseEnded"));
      window.location.href = "/dashboard";
    } catch {
      setError(tCommon("savingError"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      {/* Active pause duration on END form */}
      {kind === "end" && pauseElapsedMs !== null && (
        <Card padding="compact">
          <p className="text-sm text-foreground-muted">
            {t("pauseDurationLabel")}{" "}
            <span className="font-semibold tabular-nums text-foreground">
              {formatElapsedMs(pauseElapsedMs, locale, false)}
            </span>
          </p>
        </Card>
      )}

      <Card padding="default">
        <DateTimePicker
          label={t("timeLabel")}
          value={startTime}
          onChange={(e) => setStartTime(e.target.value)}
          max={toDatetimeLocal(new Date(), tz)}
        />
      </Card>

      {/* Reason selection (begin only) — Reinigung / Toilette per settings */}
      {showReasons && (
        <Card padding="default">
          <p className="text-sm font-medium text-foreground mb-2">
            {t("reasonLabel")}<span className="text-warn ml-1">*</span>
          </p>
          <div className="flex flex-wrap gap-2">
            {reasons.map((r) => (
              <button
                key={r.grund}
                type="button"
                onClick={() => setGrund(r.grund)}
                className={`px-4 py-2 rounded-xl text-sm font-medium border transition ${grund === r.grund ? "bg-btn-primary text-white border-transparent" : "bg-surface-raised text-foreground border-border hover:bg-background-hover"}`}
              >
                {tOpen(r.grund === "REINIGUNG" ? "grundReinigung" : "grundToilette")}
              </button>
            ))}
          </div>
          {selectedReason && (
            <p className="text-xs text-foreground-faint mt-2">
              {t("reasonMaxHint", { min: selectedReason.maxMinuten })}
              {selectedReason.maxProTag > 0 ? ` · ${t("reasonPerDayHint", { count: selectedReason.maxProTag })}` : ""}
            </p>
          )}
        </Card>
      )}

      {/* Photo section */}
      <Card padding="default">
        <p className="text-sm font-medium text-foreground mb-2">
          {t("photoLabel")}{requirePhoto && <span className="text-warn ml-1">*</span>}
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
              <PhotoCapture onFile={handleFile} uploading={uploading} variant="emerald" compact />
              <button
                type="button"
                onClick={clearPhoto}
                className="text-xs text-warn hover:opacity-80 w-fit transition"
              >
                {tCommon("removePhoto")}
              </button>
            </div>
          </div>
        ) : (
          <>
            <PhotoCapture onFile={handleFile} uploading={uploading} variant="emerald" mobileDesktopMode={mobileDesktopMode} />
            {uploadError && !uploading && <p className="text-xs text-warn font-medium mt-1">{uploadError}</p>}
          </>
        )}
      </Card>

      {/* Note */}
      <Card padding="default">
        <Textarea
          label={t("noteLabel")}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder={t("notePlaceholder")}
        />
      </Card>

      <FormError message={error} />

      <Button type="submit" loading={saving} variant="primary">
        {t(kind === "begin" ? "submitBegin" : "submitEnd")}
      </Button>
    </form>
  );
}
