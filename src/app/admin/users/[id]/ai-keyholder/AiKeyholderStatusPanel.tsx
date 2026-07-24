"use client";

import { useState, useCallback, useEffect } from "react";
import { useTranslations } from "next-intl";
import { RefreshCw, Play, Plus, Image as ImageIcon, Film, Clock, Activity } from "lucide-react";
import Card from "@/app/components/Card";
import Button from "@/app/components/Button";
import FormError from "@/app/components/FormError";

// ── Types ─────────────────────────────────────────────────────────────────────

interface MediaCount {
  queued: number;
  generating: number;
  ready: number;
  assigned: number;
  failed: number;
}

interface ActivityEntry {
  id: string;
  content: string;
  createdAt: string;
}

interface MediaItem {
  id: string;
  mediaType: string;
  status: string;
  prompt: string | null;
  filePath: string | null;
  failedReason: string | null;
  createdAt: string;
  assignedAt: string | null;
}

interface StatusData {
  counts: MediaCount;
  activityLog: ActivityEntry[];
  recentMedia: MediaItem[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusColor(status: string): string {
  switch (status) {
    case "queued":
      return "bg-[var(--color-warn-bg)] text-[var(--color-warn-text)] border-[var(--color-warn-border)]";
    case "generating":
      return "bg-[var(--color-unlock-bg)] text-[var(--color-unlock-text)] border-[var(--color-unlock-border)]";
    case "ready":
      return "bg-[var(--color-ok-bg)] text-[var(--color-ok-text)] border-[var(--color-ok-border)]";
    case "assigned":
      return "bg-surface-raised text-foreground-muted border-[var(--color-border)]";
    case "failed":
      return "bg-[var(--color-warn-bg)] text-[var(--color-warn-text)] border-[var(--color-warn-border)]";
    default:
      return "bg-surface-raised text-foreground-muted border-[var(--color-border)]";
  }
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "gerade eben";
  if (m < 60) return `vor ${m} Min.`;
  const h = Math.floor(m / 60);
  if (h < 24) return `vor ${h} Std.`;
  return `vor ${Math.floor(h / 24)} Tagen`;
}

// ── Component ─────────────────────────────────────────────────────────────────

interface AiKeyholderStatusPanelProps {
  userId: string;
  nextRunAt: string | null;
  randomIntervalMinMin: number;
  randomIntervalMinMax: number;
  moodScore: number | null;
  moodHistory: number[];
}

function MoodSparkline({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const w = 96, h = 22, pad = 2;
  const coords = points
    .map((p, i) => {
      const x = pad + (i / (points.length - 1)) * (w - 2 * pad);
      const y = pad + (1 - Math.max(0, Math.min(100, p)) / 100) * (h - 2 * pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const midY = pad + (1 - 50 / 100) * (h - 2 * pad);
  return (
    <svg width={w} height={h} className="shrink-0" aria-hidden>
      <line x1={pad} y1={midY} x2={w - pad} y2={midY} stroke="currentColor" strokeWidth={0.5} className="text-foreground-faint" />
      <polyline points={coords} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" className="text-accent" />
    </svg>
  );
}

function moodBandLabel(score: number): string {
  if (score < 20) return "frostig";
  if (score < 40) return "unzufrieden";
  if (score < 60) return "neutral";
  if (score < 80) return "zufrieden";
  return "sehr zufrieden";
}

export default function AiKeyholderStatusPanel({
  userId,
  nextRunAt: initialNextRunAt,
  randomIntervalMinMin,
  randomIntervalMinMax,
  moodScore,
  moodHistory,
}: AiKeyholderStatusPanelProps) {
  const t = useTranslations("admin");

  const [data, setData] = useState<StatusData | null>(null);
  const [loading, setLoading] = useState(false);
  const [polling, setPolling] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [nextRunAt, setNextRunAt] = useState<string | null>(initialNextRunAt);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/ai-keyholder/${userId}/status`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as StatusData;
      setData(json);
      setLastRefreshed(new Date());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [userId]);

  // Auto-refresh on mount
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-refresh every 30s when jobs are in flight
  useEffect(() => {
    if (!data?.counts.generating && !data?.counts.queued) return;
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [data?.counts.generating, data?.counts.queued, refresh]);

  const triggerPoll = async () => {
    setPolling(true);
    setError(null);
    try {
      const res = await fetch("/api/ai-keyholder/media-poll", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setPolling(false);
    }
  };

  const triggerGenerate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/ai-keyholder/generate-media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setGenerating(false);
    }
  };

  const counts: MediaCount = data?.counts ?? {
    queued: 0,
    generating: 0,
    ready: 0,
    assigned: 0,
    failed: 0,
  };

  return (
    <Card>
      <div className="flex flex-col gap-4 p-4">
        {/* Header */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-foreground-muted" />
            <span className="text-sm font-semibold text-foreground">
              {t("aikhStatusTitle")}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {lastRefreshed && (
              <span className="text-xs text-foreground-muted hidden sm:block">
                {formatRelative(lastRefreshed.toISOString())}
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={refresh}
              loading={loading}
              icon={<RefreshCw className="w-3.5 h-3.5" />}
            >
              {t("aikhStatusRefresh")}
            </Button>
          </div>
        </div>

        {moodScore != null && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-foreground-muted">{t("aikhStatusMood")}:</span>
            <span className="font-semibold text-accent tabular-nums">{moodBandLabel(moodScore)} · {moodScore}/100</span>
            <MoodSparkline points={moodHistory} />
          </div>
        )}

        {error && <FormError message={error} />}

        {/* Schedule info */}
        <div className="flex items-center gap-2 text-xs text-foreground-muted">
          <Clock className="w-3.5 h-3.5 shrink-0" />
          <span>
            {t("aikhStatusInterval", { min: randomIntervalMinMin, max: randomIntervalMinMax })}
            {nextRunAt && (() => {
              const diffMin = Math.round((new Date(nextRunAt).getTime() - Date.now()) / 60_000);
              return diffMin > 0
                ? ` · ${t("aikhNextRunIn", { minutes: diffMin })}`
                : ` · ${t("aikhNextRunSoon")}`;
            })()}
          </span>
        </div>

        {/* Media queue counters */}
        <div>
          <p className="text-xs font-medium text-foreground-muted uppercase tracking-wide mb-2">
            {t("aikhStatusMediaQueue")}
          </p>
          <div className="flex flex-wrap gap-2">
            {(["queued", "generating", "ready", "assigned", "failed"] as const).map((key) => (
              <div
                key={key}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-medium ${statusColor(key)}`}
              >
                <span>{t(`aikhStatus_${key}`)}</span>
                <span className="font-bold tabular-nums">{counts[key]}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={triggerPoll}
            loading={polling}
            icon={<Play className="w-3.5 h-3.5" />}
          >
            {t("aikhStatusTriggerPoll")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={triggerGenerate}
            loading={generating}
            icon={<Plus className="w-3.5 h-3.5" />}
          >
            {t("aikhStatusGenerateNew")}
          </Button>
        </div>

        {/* Activity log */}
        <div>
          <p className="text-xs font-medium text-foreground-muted uppercase tracking-wide mb-2">
            {t("aikhStatusActivityLog")}
          </p>
          {data?.activityLog.length ? (
            <div className="flex flex-col gap-1.5 max-h-48 overflow-y-auto pr-1">
              {data.activityLog.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-start gap-2 text-xs bg-surface-raised rounded-lg px-3 py-2"
                >
                  <span className="text-foreground-muted shrink-0 mt-0.5 whitespace-nowrap">
                    {formatRelative(entry.createdAt)}
                  </span>
                  <span className="text-foreground line-clamp-2">{entry.content}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-foreground-muted italic">
              {t("aikhStatusNoActivity")}
            </p>
          )}
        </div>

        {/* Recent media thumbnails */}
        <div>
          <p className="text-xs font-medium text-foreground-muted uppercase tracking-wide mb-2">
            {t("aikhStatusRecentMedia")}
          </p>
          {data?.recentMedia.length ? (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
              {data.recentMedia.slice(0, 12).map((m) => (
                <div key={m.id} className="relative group">
                  <div
                    className={`aspect-square rounded-lg border overflow-hidden flex items-center justify-center ${statusColor(m.status)}`}
                  >
                    {m.filePath && m.status !== "failed" ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`/api/uploads/${m.filePath}`}
                        alt={m.prompt ?? "media"}
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = "none";
                        }}
                      />
                    ) : m.mediaType === "video" ? (
                      <Film className="w-5 h-5 opacity-50" />
                    ) : (
                      <ImageIcon className="w-5 h-5 opacity-50" />
                    )}
                  </div>
                  {/* Status label */}
                  <span
                    className={`absolute bottom-0.5 right-0.5 text-[9px] font-bold px-1 rounded ${statusColor(m.status)}`}
                  >
                    {m.status}
                  </span>
                  {/* Fail reason tooltip */}
                  {m.failedReason && (
                    <div className="absolute bottom-full left-0 mb-1 hidden group-hover:block z-10 w-44 text-xs bg-[var(--color-surface-3)] border border-[var(--color-border)] rounded-lg p-2 text-foreground shadow-lg">
                      {m.failedReason}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-foreground-muted italic">
              {t("aikhStatusNoMedia")}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
