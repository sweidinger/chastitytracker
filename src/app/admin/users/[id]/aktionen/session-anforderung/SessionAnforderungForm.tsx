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
  const [nachricht, setNachricht] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

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
      };
      if (hasDeadline) {
        const h = parseFloat(deadlineHours);
        if (!isNaN(h) && h > 0) payload.deadlineHours = h;
      }
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
          onChange={(e) => setCategoryId(e.target.value)}
          options={categories.map((c) => ({ value: c.id, label: `${c.name} (max. ${c.maxSessionMinutes} Min.)` }))}
        />

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
