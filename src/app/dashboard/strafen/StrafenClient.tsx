"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations, useLocale } from "next-intl";
import { Gavel, CheckCircle, Clock, X, Camera } from "lucide-react";
import Card from "@/app/components/Card";
import Button from "@/app/components/Button";
import Textarea from "@/app/components/Textarea";
import FormError from "@/app/components/FormError";
import EmptyState from "@/app/components/EmptyState";
import PhotoCapture from "@/app/components/PhotoCapture";
import RotatableImagePreview from "@/app/components/RotatableImagePreview";
import ImageViewer from "@/app/components/ImageViewer";
import useToast from "@/app/hooks/useToast";
import { usePhotoUpload } from "@/app/hooks/usePhotoUpload";
import { formatDateTime } from "@/lib/utils";
import type { StrafStatus } from "@/lib/strafErledigung";

export interface StrafeRow {
  refId: string;
  status: StrafStatus;
  strafe: string | null;
  verhaengtAm: string;      // ISO
  gemeldetAt: string | null;
  erledigtAt: string | null;
  nachweisUrl: string | null;
  erledigungNotiz: string | null;
  ablehnungGrund: string | null;
}

const STATUS_STYLE: Record<StrafStatus, { color: string; Icon: typeof Gavel }> = {
  offen:    { color: "var(--color-warn)",   Icon: Gavel },
  gemeldet: { color: "var(--color-inspect)", Icon: Clock },
  erledigt: { color: "var(--color-ok)",     Icon: CheckCircle },
};

/** Strafen des Subs: offene melden (optional mit Nachweis), gemeldete warten auf Prüfung. */
export default function StrafenClient({ strafen, mobileDesktopMode }: { strafen: StrafeRow[]; mobileDesktopMode?: boolean }) {
  const t = useTranslations("strafen");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const toast = useToast();
  const locale = useLocale();

  const [openFor, setOpenFor] = useState<string | null>(null);
  const [notiz, setNotiz] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const startTime = new Date().toISOString();
  const { imageUrl, imagePreview, uploading, uploadError, rotation, rotateLeft, rotateRight, handleFile, clearPhoto } =
    usePhotoUpload({ startTime });

  function openForm(refId: string) {
    setOpenFor(refId);
    setNotiz("");
    setError("");
    clearPhoto();
  }

  async function submit(refId: string) {
    setSaving(true); setError("");
    try {
      const r = await fetch("/api/strafen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refId, nachweisUrl: imageUrl || null, notiz: notiz || null }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(data.error ?? t("errorGeneric"));
      } else {
        toast.success(t("reportedToast"));
        setOpenFor(null);
        clearPhoto();
        router.refresh();
      }
    } catch {
      setError(t("errorNetwork"));
    }
    setSaving(false);
  }

  if (strafen.length === 0) {
    return (
      <Card>
        <EmptyState icon={<CheckCircle size={28} />} title={t("emptyTitle")} description={t("emptyHint")} />
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {strafen.map((s) => {
        const style = STATUS_STYLE[s.status];
        const { Icon } = style;
        const isOpen = openFor === s.refId;
        return (
          <Card key={s.refId}>
            <div className="flex gap-3">
              <div
                className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                style={{ background: `color-mix(in srgb, ${style.color} 14%, transparent)`, color: style.color }}
              >
                <Icon size={18} strokeWidth={2} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-lg"
                    style={{ background: `color-mix(in srgb, ${style.color} 12%, transparent)`, color: style.color }}
                  >
                    {t(`status_${s.status}`)}
                  </span>
                  <span className="text-xs text-foreground-faint">{formatDateTime(s.verhaengtAm, locale)}</span>
                </div>
                <p className="text-sm text-foreground mt-1 break-words">{s.strafe ?? t("noText")}</p>

                {s.ablehnungGrund && s.status === "offen" && (
                  <p className="text-xs text-warn mt-2">{t("rejectedHint", { reason: s.ablehnungGrund })}</p>
                )}

                {s.status === "gemeldet" && (
                  <div className="mt-2 flex flex-col gap-1">
                    <p className="text-xs text-foreground-muted">{t("pendingHint")}</p>
                    {s.erledigungNotiz && <p className="text-xs text-foreground-faint break-words">„{s.erledigungNotiz}"</p>}
                    {s.nachweisUrl && (
                      <ImageViewer src={s.nachweisUrl} alt={t("proofAlt")} width={96} height={96} className="mt-1 rounded-lg" />
                    )}
                  </div>
                )}

                {s.status === "erledigt" && s.erledigtAt && (
                  <p className="text-xs text-foreground-faint mt-1">{t("doneAt", { date: formatDateTime(s.erledigtAt, locale) })}</p>
                )}

                {s.status === "offen" && !isOpen && (
                  <button type="button" onClick={() => openForm(s.refId)}
                    className="mt-2 text-xs font-semibold px-3 py-1.5 rounded-lg border border-warn-border text-warn hover:opacity-80 transition">
                    {t("report")}
                  </button>
                )}

                {isOpen && (
                  <div className="mt-3 flex flex-col gap-2 border-t border-border-subtle pt-3">
                    <div className="flex items-center gap-2">
                      <Camera size={14} className="text-foreground-muted" />
                      <p className="text-xs font-semibold text-foreground">{t("proofTitle")}</p>
                      <button type="button" onClick={() => setOpenFor(null)}
                        className="ml-auto text-foreground-faint hover:text-foreground transition">
                        <X size={15} />
                      </button>
                    </div>
                    <p className="text-xs text-foreground-muted">{t("proofHint")}</p>

                    {imagePreview ? (
                      <div className="flex items-start gap-4">
                        <RotatableImagePreview
                          src={imagePreview} rotation={rotation}
                          onRotateLeft={rotateLeft} onRotateRight={rotateRight}
                        />
                        <div className="flex flex-col gap-2 flex-1 pt-1">
                          <PhotoCapture onFile={handleFile} uploading={uploading} variant="orange" compact />
                          <button type="button" onClick={clearPhoto}
                            className="text-xs text-warn hover:opacity-80 w-fit transition">
                            {tCommon("removePhoto")}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <PhotoCapture onFile={handleFile} uploading={uploading} variant="orange" mobileDesktopMode={mobileDesktopMode} />
                    )}
                    <FormError message={uploadError} variant="compact" />

                    <Textarea
                      label={t("noteLabel")} value={notiz} onChange={(e) => setNotiz(e.target.value)}
                      placeholder={t("notePlaceholder")} rows={2}
                    />
                    <FormError message={error} variant="compact" />
                    <div className="flex gap-2 justify-end">
                      <Button variant="ghost" size="sm" onClick={() => setOpenFor(null)}>{t("cancel")}</Button>
                      <Button size="sm" loading={saving} disabled={uploading} onClick={() => submit(s.refId)}>{t("submit")}</Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
