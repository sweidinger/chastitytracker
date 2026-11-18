"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import Card from "@/app/components/Card";
import Button from "@/app/components/Button";
import Select from "@/app/components/Select";
import Badge from "@/app/components/Badge";
import FormError from "@/app/components/FormError";
import FormSuccess from "@/app/components/FormSuccess";

interface LockLite {
  code: string;
  status: string | null;
  nfcUid: string | null;
  /** Sicherheits-Feature: vom Sub per Tag-Scan verifiziert. */
  verified?: boolean;
}

interface Props {
  userId: string;
  /** Alle dem Sub zugewiesenen Locks (Pool). */
  assigned: LockLite[];
  /** Code des Locks, das gerade in einem aktiven Verschluss steckt (eingefroren) — nicht freigebbar. */
  activeCode: string | null;
  available: LockLite[];
  airlockOn: boolean;
  /** Semantischer Code des Lock-Lade-Fehlers; die Übersetzung passiert hier im Client. */
  locksError: "unreachable" | "error" | null;
}

export default function AirlockAssignmentForm({ userId, assigned, activeCode, available, airlockOn, locksError }: Props) {
  const t = useTranslations("admin");
  const router = useRouter();

  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function post(body: Record<string, unknown>) {
    setError(null);
    setSuccess(null);
    setBusy(true);
    try {
      const res = await fetch("/api/admin/airlock/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const code = data.error as string | undefined;
        if (code === "AIRLOCK_LOCK_ASSIGNED_OTHER") throw new Error(t("airlockAssignedOther"));
        if (code === "AIRLOCK_LOCK_NOT_FOUND") throw new Error(t("airlockLockNotFound"));
        if (code === "AIRLOCK_LOCK_ACTIVE") throw new Error(t("airlockActiveLock"));
        throw new Error(t("airlockError"));
      }
      setSuccess(t("airlockAssignSaved"));
      setSelected("");
      router.refresh();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  const options = available.map((l) => ({ value: l.code, label: `#${l.code}` }));

  return (
    <div className="flex flex-col gap-4">
      <div className="mb-1">
        <h2 className="text-base font-semibold text-foreground">{t("airlockAssignTitle")}</h2>
        <p className="text-sm text-foreground-muted mt-0.5">{t("airlockAssignDesc")}</p>
      </div>

      {!airlockOn && <FormError message={t("airlockDisabledHint")} variant="card" />}

      <Card>
        <div className="flex flex-col gap-4">
          {/* Zugewiesene Locks (Pool) — mehrere möglich, jedes einzeln freigebbar. Das gerade in einem
              aktiven Verschluss steckende Lock ist eingefroren und kann erst nach dem Ablegen frei. */}
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-semibold uppercase tracking-wider text-foreground-muted">{t("airlockAssignedLocks")}</p>
            {assigned.length > 0 ? (
              <div className="flex flex-col gap-2">
                {assigned.map((lock) => {
                  const isActive = lock.code === activeCode;
                  return (
                    <div key={lock.code} className="flex items-center justify-between gap-3 flex-wrap">
                      <div className="flex items-center gap-2">
                        <Badge variant="lock" label={`#${lock.code}`} />
                        <span className="font-mono text-xs text-foreground-faint">{lock.nfcUid ?? "—"}</span>
                        {lock.verified
                          ? <Badge variant="ok" label={t("airlockVerifiedBadge")} />
                          : <Badge variant="warn" label={t("airlockUnverifiedBadge")} />}
                        {isActive && <span className="text-xs font-medium text-lock">{t("airlockActiveBadge")}</span>}
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={busy}
                        disabled={isActive}
                        title={isActive ? t("airlockActiveLock") : undefined}
                        onClick={() => post({ action: "release", code: lock.code })}
                      >
                        {t("airlockReleaseBtn")}
                      </Button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-foreground-muted">{t("airlockAssignNone")}</p>
            )}
          </div>

          {locksError && <FormError message={t(locksError === "unreachable" ? "airlockUnreachable" : "airlockError")} />}

          {/* Zuweisen */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Select
                label={t("airlockAssignSelect")}
                options={options}
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                placeholder={t("airlockAssignSelect")}
                disabled={!airlockOn || options.length === 0}
              />
            </div>
            <Button
              variant="primary"
              loading={busy}
              disabled={!selected}
              onClick={() => post({ action: "assign", userId, code: selected })}
            >
              {t("airlockAssignBtn")}
            </Button>
          </div>

          <FormError message={error} />
          <FormSuccess message={success} />
        </div>
      </Card>
    </div>
  );
}
