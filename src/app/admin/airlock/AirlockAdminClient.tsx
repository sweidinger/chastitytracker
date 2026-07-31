"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import Card from "@/app/components/Card";
import Button from "@/app/components/Button";
import Toggle from "@/app/components/Toggle";
import Input from "@/app/components/Input";
import Badge from "@/app/components/Badge";
import FormError from "@/app/components/FormError";
import FormSuccess from "@/app/components/FormSuccess";
import { Plug, RefreshCw, Save } from "lucide-react";

interface ConfigSafe {
  enabled: boolean;
  baseUrl: string | null;
  apiKeySet: boolean;
}

interface LockView {
  code: string;
  status: string | null;
  nfcUid: string | null;
  available: boolean;
  assignedUserId: string | null;
  assignedUsername: string | null;
  lastSyncedAt: string | null;
}

export default function AirlockAdminClient({ initial }: { initial: ConfigSafe }) {
  const t = useTranslations("admin");

  const [enabled, setEnabled] = useState(initial.enabled);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [apiKeySet, setApiKeySet] = useState(initial.apiKeySet);
  const [clearKey, setClearKey] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  const [loadingLocks, setLoadingLocks] = useState(false);
  const [locks, setLocks] = useState<LockView[] | null>(null);
  const [locksError, setLocksError] = useState<string | null>(null);

  async function handleSave() {
    setError(null);
    setSuccess(null);
    setSaving(true);
    try {
      const res = await fetch("/api/admin/airlock/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          baseUrl: baseUrl.trim() || null,
          ...(clearKey ? { apiKey: "" } : apiKey !== "" ? { apiKey } : {}),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? t("airlockSaveFailed"));
      }
      const { config } = (await res.json()) as { config: ConfigSafe };
      setApiKeySet(config.apiKeySet);
      setApiKey("");
      setClearKey(false);
      setSuccess(t("airlockSaved"));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setLog([]);
    try {
      const res = await fetch("/api/admin/airlock/test", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { log?: string[]; message?: string };
      setLog(data.log ?? [data.message ?? t("airlockError")]);
    } catch (e) {
      setLog([`✗ ${String(e instanceof Error ? e.message : e)}`]);
    } finally {
      setTesting(false);
    }
  }

  async function handleLoadLocks() {
    setLoadingLocks(true);
    setLocksError(null);
    try {
      const res = await fetch("/api/admin/airlock/locks");
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; locks?: LockView[]; unreachable?: boolean; message?: string };
      if (!res.ok || !data.ok) {
        setLocks(null);
        setLocksError(data.unreachable ? t("airlockUnreachable") : (data.message ?? t("airlockError")));
        return;
      }
      setLocks(data.locks ?? []);
    } catch {
      setLocks(null);
      setLocksError(t("airlockUnreachable"));
    } finally {
      setLoadingLocks(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="mb-1">
        <h2 className="text-base font-semibold text-foreground">{t("airlockPageTitle")}</h2>
        <p className="text-sm text-foreground-muted mt-0.5">{t("airlockPageDesc")}</p>
      </div>

      {/* Verbindung */}
      <Card>
        <div className="flex flex-col gap-4">
          <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">{t("airlockConnTitle")}</h3>

          <Toggle
            label={t("airlockEnabledLabel")}
            description={t("airlockEnabledDesc")}
            checked={enabled}
            onChange={setEnabled}
          />

          <Input
            label={t("airlockBaseUrlLabel")}
            hint={t("airlockBaseUrlHint")}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://airlock.example.ch"
            inputMode="url"
            autoComplete="off"
          />

          <div className="flex flex-col gap-1.5">
            <Input
              label={t("airlockApiKeyLabel")}
              hint={t("airlockApiKeyHint")}
              type="password"
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); if (e.target.value) setClearKey(false); }}
              placeholder={apiKeySet ? "•••••••• (" + t("airlockApiKeySet") + ")" : ""}
              autoComplete="off"
              disabled={clearKey}
            />
            {apiKeySet && (
              <label className="flex items-center gap-2 text-xs text-foreground-muted">
                <input type="checkbox" checked={clearKey} onChange={(e) => { setClearKey(e.target.checked); if (e.target.checked) setApiKey(""); }} />
                {t("airlockApiKeyClear")}
              </label>
            )}
          </div>

          <FormError message={error} />
          <FormSuccess message={success} />

          <div className="flex flex-wrap gap-2">
            <Button variant="primary" loading={saving} onClick={handleSave} icon={<Save size={16} />}>
              {t("airlockSave")}
            </Button>
            <Button variant="secondary" loading={testing} onClick={handleTest} icon={<Plug size={16} />}>
              {testing ? t("airlockTesting") : t("airlockTest")}
            </Button>
          </div>

          {log.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-foreground-muted mb-1">{t("airlockLogTitle")}</p>
              <pre className="text-xs bg-background-subtle border border-border rounded-xl px-3 py-2 whitespace-pre-wrap break-words text-foreground-muted font-mono">{log.join("\n")}</pre>
            </div>
          )}
        </div>
      </Card>

      {/* Lock-Inventar */}
      <Card>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">{t("airlockLocksTitle")}</h3>
            <Button variant="secondary" size="sm" loading={loadingLocks} onClick={handleLoadLocks} icon={<RefreshCw size={14} />}>
              {t("airlockRefreshLocks")}
            </Button>
          </div>

          {locksError && <FormError message={locksError} />}

          {locks && locks.length === 0 && !locksError && (
            <p className="text-sm text-foreground-muted">{t("airlockNoLocks")}</p>
          )}

          {locks && locks.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider text-foreground-faint border-b border-border-subtle">
                    <th className="py-2 pr-3 font-semibold">{t("airlockColCode")}</th>
                    <th className="py-2 pr-3 font-semibold">{t("airlockColStatus")}</th>
                    <th className="py-2 pr-3 font-semibold">{t("airlockColUid")}</th>
                    <th className="py-2 pr-3 font-semibold">{t("airlockColAssigned")}</th>
                  </tr>
                </thead>
                <tbody>
                  {locks.map((l) => (
                    <tr key={l.code} className="border-b border-border-subtle last:border-0">
                      <td className="py-2 pr-3 font-mono font-medium text-foreground">{l.code}</td>
                      <td className="py-2 pr-3">
                        {l.available
                          ? <Badge variant="ok" size="sm" label={t("airlockAvailable")} />
                          : <Badge variant="neutral" size="sm" label={l.status ?? "—"} />}
                      </td>
                      <td className="py-2 pr-3 font-mono text-xs text-foreground-faint">{l.nfcUid ?? "—"}</td>
                      <td className="py-2 pr-3 text-foreground-muted">{l.assignedUsername ?? <span className="text-foreground-faint">{t("airlockUnassigned")}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
