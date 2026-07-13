"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PlayCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import ActionModal from "@/app/components/ActionModal";
import Select from "@/app/components/Select";
import Input from "@/app/components/Input";
import Textarea from "@/app/components/Textarea";
import FormError from "@/app/components/FormError";
import Button from "@/app/components/Button";

interface SessionCategory {
  id: string;
  name: string;
  maxSessionMinutes: number;
  requiresVideo: boolean;
  orgasmusZiel: string;
  devices: { id: string; name: string }[];
}

export default function SessionAnforderungForm({
  userId,
  categories,
}: {
  userId: string;
  categories: SessionCategory[];
}) {
  const t = useTranslations("admin");
  const tc = useTranslations("common");
  const router = useRouter();
  const close = () => router.push(`/admin/users/${userId}/aktionen`);

  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? "");
  const [deadlineHours, setDeadlineHours] = useState("4");
  const [hasDeadline, setHasDeadline] = useState(true);
  const [minMinuten, setMinMinuten] = useState("");
  const [delayMinutes, setDelayMinutes] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [requireVideo, setRequireVideo] = useState(categories[0]?.requiresVideo ?? false);
  const [orgasmusZiel, setOrgasmusZiel] = useState(categories[0]?.orgasmusZiel ?? "KEINE");
  const [orgasmusRuiniert, setOrgasmusRuiniert] = useState(false);
  const [istStrafe, setIstStrafe] = useState(false);
  const [nachricht, setNachricht] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const selectedCategory = categories.find((c) => c.id === categoryId) ?? null;

  function handleCategoryChange(id: string) {
    setCategoryId(id);
    setDeviceId("");
    const cat = categories.find((c) => c.id === id);
    setRequireVideo(cat?.requiresVideo ?? false);
    setOrgasmusZiel(cat?.orgasmusZiel ?? "KEINE");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!categoryId) {
      setError(t("sessionAnforderungCategoryRequired"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      const payload: Record<string, unknown> = {
        userId,
        deviceCategoryId: categoryId,
        nachricht: nachricht.trim() || undefined,
        requireVideo,
      };
      if (hasDeadline) {
        const h = parseFloat(deadlineHours);
        if (!isNaN(h) && h > 0) payload.deadlineHours = h;
      }
      const mm = parseInt(minMinuten, 10);
      if (!isNaN(mm) && mm > 0) payload.minMinuten = mm;
      const dm = parseInt(delayMinutes, 10);
      if (!isNaN(dm) && dm > 0) payload.delayMinutes = dm;
      if (deviceId) payload.deviceId = deviceId;
      if (istStrafe) payload.istStrafe = true;
      payload.orgasmusZiel = orgasmusZiel;
      if (orgasmusZiel === "ERFORDERLICH") payload.orgasmusRuiniert = orgasmusRuiniert;
      const res = await fetch("/api/admin/session-anforderung", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        close();
      } else {
        setError(data.error || tc("error"));
      }
    } catch {
      setError(tc("networkError"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ActionModal
      open={true}
      onClose={close}
      title={t("requestSession")}
      icon={<PlayCircle size={20} strokeWidth={2} style={{ color: "var(--color-request)" }} />}
      iconBg="var(--color-request-bg)"
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Select
          label={t("sessionAnforderungCategory")}
          value={categoryId}
          onChange={(e) => handleCategoryChange(e.target.value)}
          options={categories.map((c) => ({ value: c.id, label: `${c.name} (max. ${c.maxSessionMinutes} Min.)` }))}
        />

        {/* Mindestdauer + bestimmtes Gerät */}
        <div className="flex flex-wrap gap-3">
          <div className="w-36">
            <Input
              label={t("sessionAnforderungMinLabel")}
              type="number"
              value={minMinuten}
              onChange={(e) => setMinMinuten(e.target.value)}
              min={1}
              max={selectedCategory?.maxSessionMinutes ?? 120}
              placeholder="—"
            />
          </div>
          <div className="w-24">
            <Input
              label={t("sessionAnforderungDelayLabel")}
              type="number"
              value={delayMinutes}
              onChange={(e) => setDelayMinutes(e.target.value)}
              min={0}
              placeholder="0"
            />
          </div>
        </div>

        {selectedCategory && selectedCategory.devices.length > 0 && (
          <Select
            label={t("sessionAnforderungDeviceLabel")}
            value={deviceId}
            onChange={(e) => setDeviceId(e.target.value)}
            options={[{ value: "", label: t("sessionAnforderungDeviceAny") }, ...selectedCategory.devices.map((d) => ({ value: d.id, label: d.name }))]}
          />
        )}

        {/* Nachweis-Pflicht (pro Anforderung wählbar, Standard aus der Kategorie) */}
        <div className="flex items-center gap-2">
          <input
            id="requireVideo"
            type="checkbox"
            checked={requireVideo}
            onChange={(e) => setRequireVideo(e.target.checked)}
            className="size-4 rounded border-border accent-foreground"
          />
          <label htmlFor="requireVideo" className="text-sm text-foreground-muted select-none cursor-pointer">
            {t("sessionAnforderungRequireVideo")}
          </label>
        </div>

        {/* Orgasmus-Ziel (pro Anforderung wählbar, Standard aus der Kategorie) */}
        <Select
          label={t("orgasmusZiel")}
          value={orgasmusZiel}
          onChange={(e) => setOrgasmusZiel(e.target.value)}
          options={[
            { value: "KEINE", label: t("orgasmusZielNone") },
            { value: "ERFORDERLICH", label: t("orgasmusZielRequired") },
            { value: "VERBOTEN", label: t("orgasmusZielForbidden") },
          ]}
        />

        {/* Ruinierter Orgasmus — nur wenn ein Orgasmus gefordert ist. */}
        {orgasmusZiel === "ERFORDERLICH" && (
          <div className="flex items-center gap-2 pl-1">
            <input
              id="orgasmusRuiniert"
              type="checkbox"
              checked={orgasmusRuiniert}
              onChange={(e) => setOrgasmusRuiniert(e.target.checked)}
              className="size-4 rounded border-border accent-foreground"
            />
            <label htmlFor="orgasmusRuiniert" className="text-sm text-foreground-muted select-none cursor-pointer">
              {t("orgasmusZielRuiniert")}
            </label>
          </div>
        )}

        {/* Als Strafe markieren */}
        <div className="flex items-center gap-2">
          <input
            id="sessionIstStrafe"
            type="checkbox"
            checked={istStrafe}
            onChange={(e) => setIstStrafe(e.target.checked)}
            className="size-4 rounded border-border accent-foreground"
          />
          <label htmlFor="sessionIstStrafe" className="text-sm text-foreground-muted select-none cursor-pointer">
            {t("sessionAnforderungIstStrafe")}
          </label>
        </div>

        {/* Deadline */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <input
              id="hasDeadline"
              type="checkbox"
              checked={hasDeadline}
              onChange={(e) => setHasDeadline(e.target.checked)}
              className="size-4 rounded border-border accent-foreground"
            />
            <label htmlFor="hasDeadline" className="text-sm text-foreground-muted select-none cursor-pointer">
              {t("sessionAnforderungDeadlineLabel")}
            </label>
          </div>
          {hasDeadline && (
            <div className="flex items-center gap-2 pl-6">
              <div className="w-24">
                <Input
                  type="number"
                  value={deadlineHours}
                  onChange={(e) => setDeadlineHours(e.target.value)}
                  min={0.5}
                  step={0.5}
                />
              </div>
              <span className="text-xs text-foreground-faint">h</span>
            </div>
          )}
        </div>

        <Textarea
          label={t("kontrolleInstruction")}
          value={nachricht}
          onChange={(e) => setNachricht(e.target.value)}
          placeholder={t("sessionAnforderungNachrichtPlaceholder")}
          rows={2}
        />

        <FormError message={error} variant="compact" />

        <Button
          type="submit"
          variant="semantic"
          semantic="request"
          fullWidth
          loading={saving}
          icon={<PlayCircle size={16} />}
        >
          {saving ? t("sending") : t("sessionAnforderungSubmit")}
        </Button>
      </form>
    </ActionModal>
  );
}
