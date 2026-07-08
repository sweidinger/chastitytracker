"use client";

import { useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useTranslations, useLocale } from "next-intl";
import Card from "@/app/components/Card";
import DateTimePicker from "@/app/components/DateTimePicker";
import Select from "@/app/components/Select";
import Textarea from "@/app/components/Textarea";
import Button from "@/app/components/Button";
import Checkbox from "@/app/components/Checkbox";
import FormError from "@/app/components/FormError";
import useToast from "@/app/hooks/useToast";
import { fromDatetimeLocal, formatElapsedMs } from "@/lib/utils";
import { categoryStyle } from "@/lib/categoryConstants";
import CategoryIconRender from "@/app/components/CategoryIcon";
import { Video } from "lucide-react";

interface Category {
  id: string;
  name: string;
  color: string;
  icon: string;
  maxSessionMinutes: number;
  requiresVideo: boolean;
  orgasmusZiel: string;
}

interface DeviceOption {
  id: string;
  name: string;
}

interface ActiveSession {
  beginEntryId: string;
  deviceId: string;
  deviceName: string;
  since: string; // ISO
}

interface Props {
  kind: "begin" | "end";
  category: Category;
  devices?: DeviceOption[];
  activeSession?: ActiveSession;
  nowDefault: string;
  tz: string;
}

export default function SessionForm({ kind, category, devices, activeSession, nowDefault, tz }: Props) {
  const t = useTranslations("sessionForm");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [startTime, setStartTime] = useState(nowDefault);
  const [deviceId, setDeviceId] = useState(
    activeSession?.deviceId ?? devices?.[0]?.id ?? "",
  );
  const [note, setNote] = useState("");
  const [goalAchieved, setGoalAchieved] = useState(false);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoPreviewUrl, setVideoPreviewUrl] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [uploadingVideo, setUploadingVideo] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const videoInputRef = useRef<HTMLInputElement>(null);

  const style = categoryStyle(category.color);

  // Elapsed time for session-end display
  const sinceMs = activeSession ? Date.now() - Date.parse(activeSession.since) : 0;
  const elapsedStr = activeSession ? formatElapsedMs(sinceMs, locale, false) : "";

  const handleVideoChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setVideoFile(file);
    setVideoUrl(null);
    setError("");

    // Preview URL
    const blobUrl = URL.createObjectURL(file);
    setVideoPreviewUrl(blobUrl);

    // Upload immediately
    setUploadingVideo(true);
    try {
      const form = new FormData();
      form.append("video", file);
      const res = await fetch("/api/upload-video", { method: "POST", body: form });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? t("videoUploadError"));
        setUploadingVideo(false);
        return;
      }
      const data = await res.json();
      setVideoUrl(data.url);
    } catch {
      setError(t("videoUploadError"));
    }
    setUploadingVideo(false);
  }, [t]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (kind === "end" && category.requiresVideo && !videoUrl) {
      setError(t("videoRequired"));
      return;
    }

    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        type: kind === "begin" ? "SESSION_BEGIN" : "SESSION_END",
        startTime: fromDatetimeLocal(startTime, tz),
        deviceId: deviceId || null,
        note: note.trim() || null,
      };
      if (kind === "end") {
        payload.sessionGoalAchieved = goalAchieved;
        if (videoUrl) payload.videoUrl = videoUrl;
      }

      const res = await fetch("/api/entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? tCommon("savingError"));
        setSaving(false);
        return;
      }
      toast.success(kind === "begin" ? t("beginSaved") : t("endSaved"));
      router.push("/dashboard");
    } catch {
      setError(tCommon("networkError"));
      setSaving(false);
    }
  }

  return (
    <Card>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-4">
        {/* Category header */}
        <div className="flex items-center gap-3">
          <div
            className="shrink-0 size-10 rounded-lg flex items-center justify-center"
            style={{ backgroundColor: style.backgroundColor, color: style.color }}
            aria-hidden
          >
            <CategoryIconRender name={category.icon} className="size-5" />
          </div>
          <div>
            <p className="text-base font-semibold text-foreground">{category.name}</p>
            <p className="text-xs text-foreground-faint">
              {t("maxDuration", { minutes: category.maxSessionMinutes })}
            </p>
          </div>
        </div>

        {/* Orgasmus-Ziel badge (always visible when set) */}
        {category.orgasmusZiel !== "KEINE" && (
          <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium ${
            category.orgasmusZiel === "VERBOTEN"
              ? "bg-[var(--color-warn-bg)] border-[var(--color-warn-border)] text-[var(--color-warn)]"
              : "bg-[var(--color-request-bg)] border-[var(--color-request-border,var(--color-border))] text-[var(--color-request)]"
          }`}>
            {category.orgasmusZiel === "ERFORDERLICH" ? t("orgasmusZielBadgeRequired") : t("orgasmusZielBadgeForbidden")}
          </div>
        )}

        {/* Active session timer (end only) */}
        {kind === "end" && activeSession && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-background-subtle border border-border">
            <span className="text-xs text-foreground-muted">{t("activeSession")}</span>
            <span className="font-mono text-base font-semibold tabular-nums text-foreground ml-auto">{elapsedStr}</span>
          </div>
        )}

        {/* Device picker (begin only — or if multiple devices) */}
        {kind === "begin" && devices && devices.length > 1 && (
          <Select
            label={t("device")}
            value={deviceId}
            onChange={(e) => setDeviceId(e.target.value)}
            disabled={saving}
            options={devices.map((d) => ({ value: d.id, label: d.name }))}
          />
        )}

        <DateTimePicker
          label={kind === "begin" ? t("startTime") : t("endTime")}
          value={startTime}
          onChange={(e) => setStartTime(e.target.value)}
          disabled={saving}
          max={nowDefault}
        />

        {/* Goal achieved (end only) */}
        {kind === "end" && (
          <Checkbox
            label={
              category.orgasmusZiel === "ERFORDERLICH"
                ? t("goalAchievedRequired")
                : category.orgasmusZiel === "VERBOTEN"
                  ? t("goalAchievedForbidden")
                  : t("goalAchieved")
            }
            checked={goalAchieved}
            onChange={(e) => setGoalAchieved(e.target.checked)}
            disabled={saving}
          />
        )}

        {/* Video upload (end only, when requiresVideo or optional) */}
        {kind === "end" && (
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-foreground-muted">
              {t(category.requiresVideo ? "videoRequired" : "videoOptional")}
              {category.requiresVideo && <span className="text-warn ml-0.5">*</span>}
            </label>
            <input
              ref={videoInputRef}
              type="file"
              accept="video/mp4,video/quicktime,video/webm,video/x-m4v"
              className="hidden"
              onChange={handleVideoChange}
              disabled={saving || uploadingVideo}
            />
            <button
              type="button"
              onClick={() => videoInputRef.current?.click()}
              disabled={saving || uploadingVideo}
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-border text-sm text-foreground-muted hover:border-foreground-muted transition disabled:opacity-50"
            >
              <Video size={16} />
              {uploadingVideo
                ? t("uploading")
                : videoUrl
                  ? t("videoSelected", { name: videoFile?.name ?? "video" })
                  : t("selectVideo")}
            </button>
            {videoPreviewUrl && (
              <video src={videoPreviewUrl} controls className="rounded-lg max-h-40 mt-1" />
            )}
          </div>
        )}

        <Textarea
          label={tCommon("note")}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={saving}
          rows={2}
          placeholder={t("notePlaceholder")}
        />

        {error && <FormError message={error} />}

        <div className="flex gap-3 pt-1">
          <Button type="button" variant="secondary" fullWidth onClick={() => router.back()} disabled={saving}>
            {tCommon("cancel")}
          </Button>
          <Button type="submit" variant="primary" fullWidth loading={saving || uploadingVideo}>
            {kind === "begin" ? t("submitBegin") : t("submitEnd")}
          </Button>
        </div>
      </form>
    </Card>
  );
}
