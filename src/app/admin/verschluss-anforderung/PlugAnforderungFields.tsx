"use client";

import { useState } from "react";
import { Anchor } from "lucide-react";
import { useTranslations } from "next-intl";
import { toDatetimeLocal, fromDatetimeLocal } from "@/lib/utils";
import DateTimePicker from "@/app/components/DateTimePicker";
import FormError from "@/app/components/FormError";
import Input from "@/app/components/Input";
import Select from "@/app/components/Select";
import Textarea from "@/app/components/Textarea";
import Button from "@/app/components/Button";
import type { DeviceOption } from "@/lib/queries";

/** Labeled full-width tab group — same helper as VerschlussAnforderungFields but local. */
function FieldTabs<T extends string>({
  label, value, options, onChange,
}: {
  label: string; value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs text-foreground-faint">{label}</label>
      <div className="flex bg-surface-raised border border-border rounded-xl overflow-hidden">
        {options.map((opt) => (
          <button key={opt.value} type="button" onClick={() => onChange(opt.value)}
            className={`flex-1 py-2 text-sm text-center transition-all ${
              value === opt.value ? "bg-foreground text-background font-semibold" : "text-foreground-muted hover:bg-border-subtle"
            }`}>
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Form body for Plug "Tragen anfordern" (ANFORDERUNG) and "Sperrdauer setzen" (SPERRZEIT).
 * Simpler than VerschlussAnforderungFields: no reinigung/toilette.
 * Sends deviceCategoryId in payload to distinguish from KG entries.
 * For ANFORDERUNG, an optional device selector shows specific plug devices.
 */
export default function PlugAnforderungFields({
  userId,
  deviceCategoryId,
  art,
  devices = [],
  tz,
  minNow,
  onSuccess,
}: {
  userId: string;
  deviceCategoryId: string;
  art: "ANFORDERUNG" | "SPERRZEIT";
  devices?: DeviceOption[];
  tz: string;
  minNow: string;
  onSuccess: () => void;
}) {
  const t = useTranslations("admin");
  const tc = useTranslations("common");
  const isSperrzeit = art === "SPERRZEIT";
  const accentColor = isSperrzeit ? "var(--color-sperrzeit)" : "var(--color-request)";

  const [nachricht, setNachricht] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [mode, setMode] = useState<"duration" | "datetime">("duration");
  const defaultDurationH = isSperrzeit ? "24" : "4";
  const [durationH, setDurationH] = useState(defaultDurationH);
  const nowBaseMs = fromDatetimeLocal(minNow, tz).getTime();
  const [endetAt, setEndetAt] = useState(() =>
    toDatetimeLocal(new Date(nowBaseMs + parseFloat(defaultDurationH) * 60 * 60 * 1000), tz)
  );
  const [scheduleMode, setScheduleMode] = useState<"immediate" | "delay" | "datetime">("immediate");
  const [delayValue, setDelayValue] = useState("30");
  const [delayUnit, setDelayUnit] = useState<"minutes" | "hours">("minutes");
  const [scheduledAt, setScheduledAt] = useState(() =>
    toDatetimeLocal(new Date(nowBaseMs + 60 * 60 * 1000), tz)
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (mode === "datetime" && endetAt && fromDatetimeLocal(endetAt, tz) <= new Date()) {
      setError(t("futureDateRequired"));
      return;
    }
    if (scheduleMode === "datetime" && scheduledAt && fromDatetimeLocal(scheduledAt, tz) <= new Date()) {
      setError(t("scheduleFutureRequired"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      const payload: Record<string, unknown> = {
        userId, art, deviceCategoryId,
        nachricht: nachricht.trim() || undefined,
      };
      if (!isSperrzeit && deviceId) payload.deviceId = deviceId;
      if (mode === "datetime" && endetAt) {
        payload.endetAt = fromDatetimeLocal(endetAt, tz).toISOString();
      } else {
        payload.fristH = parseFloat(durationH) || (isSperrzeit ? 24 : 4);
      }
      if (scheduleMode === "datetime" && scheduledAt) {
        payload.wirksamAbAt = fromDatetimeLocal(scheduledAt, tz).toISOString();
      } else if (scheduleMode === "delay") {
        const v = parseFloat(delayValue) || 0;
        payload.delayMinutes = delayUnit === "hours" ? v * 60 : v;
      }

      const res = await fetch("/api/admin/verschluss-anforderung", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) onSuccess();
      else setError(data.error || tc("error"));
    } catch {
      setError(tc("networkError"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Textarea
        label={t("kontrolleInstruction")}
        value={nachricht}
        onChange={(e) => setNachricht(e.target.value)}
        placeholder={isSperrzeit ? t("plugSperrzeitNachrichtPlaceholder") : t("plugAnforderungNachrichtPlaceholder")}
        rows={2}
      />

      <FieldTabs
        label={isSperrzeit ? t("plugSperrzeitDauerLabel") : t("frist")}
        value={mode}
        onChange={setMode}
        options={[
          { value: "duration", label: t("durationHours") },
          { value: "datetime", label: t("untilDate") },
        ]}
      />

      {mode === "duration" ? (
        <div className="flex items-center gap-2">
          <div className="w-24">
            <Input type="number" value={durationH} onChange={(e) => setDurationH(e.target.value)} min={0.5} step={0.5} />
          </div>
          <span className="text-xs text-foreground-faint">h</span>
        </div>
      ) : (
        <DateTimePicker
          value={endetAt}
          onChange={(e) => setEndetAt(e.target.value)}
          min={minNow}
          hint={isSperrzeit ? t("plugSperrzeitEndetHint") : t("endetHintAnforderung")}
        />
      )}

      {!isSperrzeit && devices.length > 0 && (
        <Select
          label={t("selectPlugDeviceLabel")}
          options={[
            { value: "", label: t("selectPlugDevicePlaceholder") },
            ...devices.map((d) => ({ value: d.id, label: d.name })),
          ]}
          value={deviceId}
          onChange={(e) => setDeviceId(e.target.value)}
        />
      )}

      <FieldTabs
        label={t("schedulingLabel")}
        value={scheduleMode}
        onChange={setScheduleMode}
        options={[
          { value: "immediate", label: t("scheduleImmediate") },
          { value: "delay", label: t("scheduleDelay") },
          { value: "datetime", label: t("scheduleAt") },
        ]}
      />

      {scheduleMode === "delay" && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <div className="w-24">
              <Input type="number" value={delayValue} onChange={(e) => setDelayValue(e.target.value)} min={1} step={1} />
            </div>
            <Select
              options={[
                { value: "minutes", label: t("scheduleDelayMinutes") },
                { value: "hours", label: t("scheduleDelayHours") },
              ]}
              value={delayUnit}
              onChange={(e) => setDelayUnit(e.target.value as "minutes" | "hours")}
            />
          </div>
          <span className="text-xs text-foreground-faint">{t("scheduleDelayHint")}</span>
        </div>
      )}

      {scheduleMode === "datetime" && (
        <DateTimePicker
          value={scheduledAt}
          onChange={(e) => setScheduledAt(e.target.value)}
          min={minNow}
          hint={t("scheduleAtHint")}
        />
      )}

      <FormError message={error} variant="compact" />

      <Button
        type="submit"
        variant="semantic"
        semantic={isSperrzeit ? "sperrzeit" : "request"}
        fullWidth
        loading={saving}
        icon={<Anchor size={16} />}
      >
        {saving ? t("sending") : (isSperrzeit ? t("plugSperrzeitSubmit") : t("plugAnforderungSubmit"))}
      </Button>
    </form>
  );
}
