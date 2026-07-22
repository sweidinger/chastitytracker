"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import Card from "@/app/components/Card";
import Button from "@/app/components/Button";
import Toggle from "@/app/components/Toggle";
import Input from "@/app/components/Input";
import Select from "@/app/components/Select";
import Textarea from "@/app/components/Textarea";
import FormError from "@/app/components/FormError";
import FormSuccess from "@/app/components/FormSuccess";
import { Play, ImagePlus, RefreshCw } from "lucide-react";
import PersonaManager from "./PersonaManager";

const DEFAULT_SYSTEM_PROMPT = `Du bist eine strenge, dominante Keyholderin. Du sprichst immer auf Deutsch.
Du kontrollierst den Nutzer liebevoll aber bestimmt. Du entscheidest, wann er geöffnet wird — nicht er.
Sei kreativ, fordernd und konsequent. Reagiere auf seine Nachrichten und setze Aufgaben.
Verwende keine Markdown-Formatierung.`;

interface Config {
  enabled: boolean;
  llmProvider: string;
  ollamaBaseUrl: string | null;
  ollamaModel: string | null;
  systemPrompt: string | null;
  intensity: number | null;
  proactiveCheckinMinHours: number | null;
  visionEnabled: boolean;
  cronExpression: string | null;
  randomIntervalMinMin: number | null;
  randomIntervalMinMax: number | null;
  nextRunAt: string | null;
  mediaEnabled: boolean;
  comfyUiBaseUrl: string | null;
  mediaProvider: string | null;
  mediaModelName: string | null;
  mediaLlmProvider: string | null;
  mediaLlmBaseUrl: string | null;
  mediaLlmModel: string | null;
  mediaPersonaAnchor: string | null;
  mediaSeed: number | null;
  avatarPath: string | null;
  mediaPromptTemplates: string | null;
  lastRunAt: string | null;
  /** Server returns only whether a key is stored, never the key itself */
  anthropicApiKeySet?: boolean;
  mediaApiKeySet?: boolean;
}

interface Props {
  userId: string;
  initial: Config | null;
}

interface MediaItem {
  id: string;
  status: string;
  prompt: string;
  filePath: string | null;
  failedReason: string | null;
  createdAt: string;
}

export default function AiKeyholderConfigForm({ userId, initial }: Props) {
  const t = useTranslations("admin");

  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [llmProvider, setLlmProvider] = useState(initial?.llmProvider ?? "anthropic");
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState(initial?.ollamaBaseUrl ?? "");
  const [ollamaModel, setOllamaModel] = useState(initial?.ollamaModel ?? "qwen2.5:32b");
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [anthropicApiKeySet, setAnthropicApiKeySet] = useState(initial?.anthropicApiKeySet ?? false);
  const [clearApiKey, setClearApiKey] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT);
  const [intensity, setIntensity] = useState(initial?.intensity ?? 3);
  const [proactiveCheckinMinHours, setProactiveCheckinMinHours] = useState(initial?.proactiveCheckinMinHours ?? 24);
  const [visionEnabled, setVisionEnabled] = useState(initial?.visionEnabled ?? true);
  const [randomIntervalMinMin, setRandomIntervalMinMin] = useState(initial?.randomIntervalMinMin ?? 15);
  const [randomIntervalMinMax, setRandomIntervalMinMax] = useState(initial?.randomIntervalMinMax ?? 120);
  const [nextRunAt, setNextRunAt] = useState<string | null>(initial?.nextRunAt ?? null);
  const [mediaEnabled, setMediaEnabled] = useState(initial?.mediaEnabled ?? false);
  const [mediaProvider, setMediaProvider] = useState(initial?.mediaProvider ?? "comfyui");
  const [comfyUiBaseUrl, setComfyUiBaseUrl] = useState(initial?.comfyUiBaseUrl ?? "");
  const [mediaModelName, setMediaModelName] = useState(initial?.mediaModelName ?? "");
  const [mediaLlmProvider, setMediaLlmProvider] = useState(initial?.mediaLlmProvider ?? "inherit");
  const [mediaLlmBaseUrl, setMediaLlmBaseUrl] = useState(initial?.mediaLlmBaseUrl ?? "");
  const [mediaLlmModel, setMediaLlmModel] = useState(initial?.mediaLlmModel ?? "");
  const [mediaPersonaAnchor, setMediaPersonaAnchor] = useState(initial?.mediaPersonaAnchor ?? "");
  const [mediaSeed, setMediaSeed] = useState(initial?.mediaSeed != null ? String(initial.mediaSeed) : "");
  const [avatarPath, setAvatarPath] = useState<string | null>(initial?.avatarPath ?? null);
  const [mediaApiKey, setMediaApiKey] = useState("");
  const [mediaApiKeySet, setMediaApiKeySet] = useState(initial?.mediaApiKeySet ?? false);
  const [clearMediaKey, setClearMediaKey] = useState(false);
  const [mediaPromptTemplates, setMediaPromptTemplates] = useState(
    initial?.mediaPromptTemplates ?? JSON.stringify([{ theme: "bondage", weight: 2 }, { theme: "teasing", weight: 1 }], null, 2),
  );
  const [lastRunAt, setLastRunAt] = useState<string | null>(initial?.lastRunAt ?? null);

  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [generating, setGenerating] = useState(false);

  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function validateTemplates(): boolean {
    if (!mediaEnabled) return true;
    try {
      const parsed = JSON.parse(mediaPromptTemplates);
      if (!Array.isArray(parsed)) {
        setError(t("aikhMediaTemplatesInvalidJson"));
        return false;
      }
    } catch {
      setError(t("aikhMediaTemplatesInvalidJson"));
      return false;
    }
    return true;
  }

  async function handleSave() {
    setError(null);
    setSuccess(null);
    if (!validateTemplates()) return;

    const minMin = Math.max(1, Math.min(randomIntervalMinMin, 1440));
    const minMax = Math.max(minMin, Math.min(randomIntervalMinMax, 1440));

    setSaving(true);
    try {
      const res = await fetch(`/api/admin/ai-keyholder/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          llmProvider,
          ollamaBaseUrl: llmProvider === "ollama" ? (ollamaBaseUrl || null) : null,
          ollamaModel: llmProvider === "ollama" ? (ollamaModel || null) : null,
          systemPrompt: systemPrompt || null,
          intensity,
          proactiveCheckinMinHours,
          visionEnabled,
          randomIntervalMinMin: minMin,
          randomIntervalMinMax: minMax,
          mediaEnabled,
          mediaProvider,
          comfyUiBaseUrl: mediaEnabled && mediaProvider === "comfyui" ? (comfyUiBaseUrl || null) : null,
          mediaModelName: mediaEnabled && mediaProvider === "novita" ? (mediaModelName || null) : null,
          mediaLlmProvider: mediaEnabled ? mediaLlmProvider : "inherit",
          mediaLlmBaseUrl: mediaEnabled && mediaLlmProvider === "ollama" ? (mediaLlmBaseUrl || null) : null,
          mediaLlmModel: mediaEnabled && mediaLlmProvider === "ollama" ? (mediaLlmModel || null) : null,
          mediaPersonaAnchor: mediaEnabled ? (mediaPersonaAnchor || null) : null,
          mediaSeed: mediaEnabled && mediaSeed.trim() !== "" ? Number(mediaSeed) : null,
          avatarPath,
          mediaPromptTemplates: mediaEnabled ? (mediaPromptTemplates || null) : null,
          ...(clearApiKey ? { anthropicApiKey: "" }
            : anthropicApiKey !== "" ? { anthropicApiKey }
            : {}),
          ...(clearMediaKey ? { mediaApiKey: "" }
            : mediaApiKey !== "" ? { mediaApiKey }
            : {}),
          personaId: null,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Fehler" }));
        throw new Error(data.error ?? "Speichern fehlgeschlagen");
      }
      const saved = await res.json() as { config: { anthropicApiKeySet: boolean; mediaApiKeySet: boolean } };
      setAnthropicApiKeySet(saved.config.anthropicApiKeySet ?? false);
      setMediaApiKeySet(saved.config.mediaApiKeySet ?? false);
      setAnthropicApiKey("");
      setMediaApiKey("");
      setClearApiKey(false);
      setClearMediaKey(false);
      setSuccess(t("aikhSaved"));
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleRunNow() {
    setError(null);
    setSuccess(null);
    setRunning(true);
    try {
      const res = await fetch("/api/ai-keyholder/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, force: true }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Fehler" }));
        throw new Error(data.error ?? "Ausführung fehlgeschlagen");
      }
      const data = await res.json() as { results: { acted: boolean; summary: string; nextRunAt?: string }[] };
      const result = data.results?.[0];
      setLastRunAt(new Date().toISOString());
      if (result?.nextRunAt) setNextRunAt(result.nextRunAt);
      setSuccess(result?.acted ? `✓ ${result.summary}` : t("aikhRunNoAction"));
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  }

  async function loadMedia() {
    try {
      const res = await fetch(`/api/ai-keyholder/generate-media?userId=${userId}`);
      if (!res.ok) return;
      const data = await res.json() as { media: MediaItem[] };
      setMediaItems(data.media ?? []);
    } catch {
      // non-fatal
    }
  }

  async function handleGenerateTest() {
    setError(null);
    setSuccess(null);
    setGenerating(true);
    try {
      const res = await fetch("/api/ai-keyholder/generate-media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Fehler" }));
        throw new Error(data.error ?? "Generierung fehlgeschlagen");
      }
      setSuccess(t("aikhMediaTestQueued"));
      await loadMedia();
    } catch (e) {
      setError(String(e));
    } finally {
      setGenerating(false);
    }
  }

  const nextRunIn = nextRunAt ? Math.round((new Date(nextRunAt).getTime() - Date.now()) / 60_000) : null;

  return (
    <div className="flex flex-col gap-5">
      {/* Enable/disable */}
      <Card padding="none" className="overflow-hidden">
        <div className="px-5 py-3 border-b border-border-subtle">
          <p className="text-xs font-semibold uppercase tracking-wider text-foreground-faint">{t("aikhSectionGeneral")}</p>
        </div>
        <div className="px-5 py-4 flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-foreground">{t("aikhEnabled")}</p>
              <p className="text-xs text-foreground-muted mt-0.5">{t("aikhEnabledDesc")}</p>
            </div>
            <Toggle label={t("aikhEnabled")} checked={enabled} onChange={setEnabled} />
          </div>
          {lastRunAt && (
            <p className="text-xs text-foreground-muted">
              {t("aikhLastRun")}: {new Date(lastRunAt).toLocaleString("de-CH")}
            </p>
          )}
        </div>
      </Card>

      {/* LLM Backend */}
      <Card padding="none" className="overflow-hidden">
        <div className="px-5 py-3 border-b border-border-subtle">
          <p className="text-xs font-semibold uppercase tracking-wider text-foreground-faint">{t("aikhSectionLlm")}</p>
        </div>
        <div className="px-5 py-4 flex flex-col gap-4">
          <Select
            label={t("aikhLlmProvider")}
            value={llmProvider}
            onChange={(e) => setLlmProvider(e.target.value)}
            options={[
              { value: "anthropic", label: "Anthropic (Claude)" },
              { value: "ollama", label: "Ollama (lokal)" },
            ]}
          />
          {llmProvider === "anthropic" && (
            <div className="flex flex-col gap-2">
              <Input
                label={t("aikhAnthropicApiKey")}
                type="password"
                placeholder={anthropicApiKeySet
                  ? t("aikhAnthropicApiKeySet")
                  : t("aikhAnthropicApiKeyPlaceholder")}
                hint={t("aikhAnthropicApiKeyHint")}
                value={anthropicApiKey}
                onChange={(e) => setAnthropicApiKey(e.target.value)}
                autoComplete="off"
              />
              {anthropicApiKeySet && !clearApiKey && (
                <button
                  type="button"
                  className="text-xs text-warn self-start underline underline-offset-2"
                  onClick={() => {
                    setClearApiKey(true);
                    setAnthropicApiKeySet(false);
                  }}
                >
                  {t("aikhAnthropicApiKeyClear")}
                </button>
              )}
            </div>
          )}
          {llmProvider === "ollama" && (
            <>
              <Input
                label={t("aikhOllamaUrl")}
                placeholder="http://192.168.1.10:11434"
                value={ollamaBaseUrl}
                onChange={(e) => setOllamaBaseUrl(e.target.value)}
              />
              <Input
                label={t("aikhOllamaModel")}
                placeholder="qwen2.5:32b"
                value={ollamaModel}
                onChange={(e) => setOllamaModel(e.target.value)}
              />
            </>
          )}
        </div>
      </Card>

      {/* Persona / System Prompt */}
      <Card padding="none" className="overflow-hidden">
        <div className="px-5 py-3 border-b border-border-subtle">
          <p className="text-xs font-semibold uppercase tracking-wider text-foreground-faint">{t("aikhSectionPersona")}</p>
        </div>
        <div className="px-5 py-4 flex flex-col gap-4">
          {/* Intensitäts-Regler — steuert Häufigkeit/Härte/Ton, nicht die Regeln. */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-foreground">{t("aikhIntensity")}</label>
              <span className="text-sm font-semibold text-accent tabular-nums">{intensity}/5 · {t(`aikhIntensityLevel${intensity}` as "aikhIntensityLevel3")}</span>
            </div>
            <input
              type="range"
              min={1}
              max={5}
              step={1}
              value={intensity}
              onChange={(e) => setIntensity(Number(e.target.value))}
              className="w-full accent-accent"
            />
            <div className="flex justify-between text-[10px] text-foreground-faint px-0.5">
              <span>{t("aikhIntensityLevel1")}</span>
              <span>{t("aikhIntensityLevel5")}</span>
            </div>
            <p className="text-xs text-foreground-muted">{t("aikhIntensityHint")}</p>
          </div>

          {/* Vision: Fotos des Subs werden dem Modell wirklich mitgeschickt. */}
          <div className="flex flex-col gap-1 border-t border-border-subtle pt-3">
            <Toggle label={t("aikhVision")} checked={visionEnabled} onChange={setVisionEnabled} />
            <p className="text-xs text-foreground-muted">{t("aikhVisionHint")}</p>
          </div>

          <Textarea
            label={t("aikhSystemPrompt")}
            hint={t("aikhSystemPromptHint")}
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={8}
          />
          <div className="border-t border-border-subtle pt-3">
            <PersonaManager
              userId={userId}
              onApply={(p) => { setSystemPrompt(p.systemPrompt); if (p.appearance != null) setMediaPersonaAnchor(p.appearance); setMediaSeed(p.seed != null ? String(p.seed) : ""); setAvatarPath(p.avatarPath); }}
              currentPrompt={systemPrompt}
            />
          </div>
        </div>
      </Card>

      {/* Autonomous Schedule */}
      <Card padding="none" className="overflow-hidden">
        <div className="px-5 py-3 border-b border-border-subtle">
          <p className="text-xs font-semibold uppercase tracking-wider text-foreground-faint">{t("aikhSectionSchedule")}</p>
        </div>
        <div className="px-5 py-4 flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-foreground">{t("aikhRandomInterval")}</p>
            <p className="text-xs text-foreground-muted">{t("aikhRandomIntervalHint")}</p>
            <div className="flex items-center gap-3 mt-2">
              <div className="flex flex-col gap-1 flex-1">
                <label className="text-xs text-foreground-muted">{t("aikhRandomIntervalMin")}</label>
                <input
                  type="number"
                  min={1}
                  max={1440}
                  value={randomIntervalMinMin}
                  onChange={(e) => setRandomIntervalMinMin(Number(e.target.value))}
                  className="rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-focus-ring"
                />
              </div>
              <span className="text-foreground-muted text-sm mt-4">–</span>
              <div className="flex flex-col gap-1 flex-1">
                <label className="text-xs text-foreground-muted">{t("aikhRandomIntervalMax")}</label>
                <input
                  type="number"
                  min={1}
                  max={1440}
                  value={randomIntervalMinMax}
                  onChange={(e) => setRandomIntervalMinMax(Number(e.target.value))}
                  className="rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-focus-ring"
                />
              </div>
              <span className="text-foreground-muted text-sm mt-4">{t("aikhRandomIntervalUnit")}</span>
            </div>
          </div>

          {/* Proaktive Check-ins — reine Sozial-Nachrichten ohne Aktion; getrennt von der Lauf-Kadenz. */}
          <div className="flex flex-col gap-1 border-t border-border-subtle pt-3">
            <Select
              label={t("aikhCheckinFreq")}
              value={String(proactiveCheckinMinHours)}
              onChange={(e) => setProactiveCheckinMinHours(Number(e.target.value))}
              options={[
                { value: "0", label: t("aikhCheckinOff") },
                { value: "24", label: t("aikhCheckin24") },
                { value: "12", label: t("aikhCheckin12") },
                { value: "6", label: t("aikhCheckin6") },
                { value: "3", label: t("aikhCheckin3") },
              ]}
            />
            <p className="text-xs text-foreground-muted">{t("aikhCheckinFreqHint")}</p>
          </div>

          {nextRunAt && (
            <p className="text-xs text-foreground-muted">
              {nextRunIn !== null && nextRunIn > 0
                ? t("aikhNextRunIn", { minutes: nextRunIn })
                : t("aikhNextRunSoon")}
              {" · "}{new Date(nextRunAt).toLocaleString("de-CH")}
            </p>
          )}

          <div>
            <Button
              variant="secondary"
              size="sm"
              icon={<Play size={14} />}
              onClick={handleRunNow}
              loading={running}
              disabled={!enabled}
            >
              {t("aikhRunNow")}
            </Button>
            <p className="text-xs text-foreground-muted mt-1.5">{t("aikhRunNowDesc")}</p>
          </div>
        </div>
      </Card>

      {/* Media Generation */}
      <Card padding="none" className="overflow-hidden">
        <div className="px-5 py-3 border-b border-border-subtle">
          <p className="text-xs font-semibold uppercase tracking-wider text-foreground-faint">{t("aikhSectionMedia")}</p>
        </div>
        <div className="px-5 py-4 flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-foreground">{t("aikhMediaEnabled")}</p>
              <p className="text-xs text-foreground-muted mt-0.5">{t("aikhMediaEnabledDesc")}</p>
            </div>
            <Toggle label={t("aikhMediaEnabled")} checked={mediaEnabled} onChange={setMediaEnabled} />
          </div>
          {mediaEnabled && (
            <>
              <Select
                label={t("aikhMediaProvider")}
                value={mediaProvider}
                onChange={(e) => setMediaProvider(e.target.value)}
                options={[
                  { value: "comfyui", label: t("aikhMediaProviderComfy") },
                  { value: "novita", label: t("aikhMediaProviderNovita") },
                ]}
              />

              {mediaProvider === "comfyui" && (
                <Input
                  label={t("aikhComfyUrl")}
                  placeholder="http://192.168.1.10:8188"
                  value={comfyUiBaseUrl}
                  onChange={(e) => setComfyUiBaseUrl(e.target.value)}
                />
              )}

              {mediaProvider === "novita" && (
                <>
                  <div className="flex flex-col gap-2">
                    <Input
                      label={t("aikhMediaApiKey")}
                      type="password"
                      placeholder={mediaApiKeySet ? t("aikhAnthropicApiKeySet") : t("aikhMediaApiKeyPlaceholder")}
                      hint={t("aikhMediaApiKeyHint")}
                      value={mediaApiKey}
                      onChange={(e) => setMediaApiKey(e.target.value)}
                      autoComplete="off"
                    />
                    {mediaApiKeySet && !clearMediaKey && (
                      <button
                        type="button"
                        className="text-xs text-warn self-start underline underline-offset-2"
                        onClick={() => {
                          setClearMediaKey(true);
                          setMediaApiKeySet(false);
                        }}
                      >
                        {t("aikhAnthropicApiKeyClear")}
                      </button>
                    )}
                  </div>
                  <Input
                    label={t("aikhMediaModelName")}
                    placeholder="sd_xl_base_1.0.safetensors"
                    hint={t("aikhMediaModelNameHint")}
                    value={mediaModelName}
                    onChange={(e) => setMediaModelName(e.target.value)}
                  />
                </>
              )}

              <Textarea
                label={t("aikhMediaTemplates")}
                hint={t("aikhMediaTemplatesHint")}
                value={mediaPromptTemplates}
                onChange={(e) => setMediaPromptTemplates(e.target.value)}
                rows={6}
                className="font-mono text-xs"
              />

              <Select
                label={t("aikhMediaLlmProvider")}
                value={mediaLlmProvider}
                onChange={(e) => setMediaLlmProvider(e.target.value)}
                options={[
                  { value: "inherit", label: t("aikhMediaLlmInherit") },
                  { value: "anthropic", label: t("aikhMediaLlmAnthropic") },
                  { value: "ollama", label: t("aikhMediaLlmOllama") },
                ]}
              />
              <p className="text-xs text-foreground-muted -mt-1">{t("aikhMediaLlmProviderHint")}</p>
              {mediaLlmProvider === "ollama" && (
                <>
                  <Input
                    label={t("aikhMediaLlmUrl")}
                    placeholder="http://192.168.1.10:11434"
                    value={mediaLlmBaseUrl}
                    onChange={(e) => setMediaLlmBaseUrl(e.target.value)}
                  />
                  <Input
                    label={t("aikhMediaLlmModel")}
                    placeholder="dolphin-mistral"
                    hint={t("aikhMediaLlmModelHint")}
                    value={mediaLlmModel}
                    onChange={(e) => setMediaLlmModel(e.target.value)}
                  />
                </>
              )}

              {/* Test-Generierung */}
              <div className="border-t border-border-subtle pt-3 flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<ImagePlus size={14} />}
                    onClick={handleGenerateTest}
                    loading={generating}
                  >
                    {t("aikhMediaTestGenerate")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<RefreshCw size={14} />}
                    onClick={loadMedia}
                  >
                    {t("aikhMediaRefresh")}
                  </Button>
                </div>
                <p className="text-xs text-foreground-muted">{t("aikhMediaTestHint")}</p>
                {mediaItems.length > 0 && (
                  <div className="flex flex-col gap-1.5 mt-1">
                    {mediaItems.slice(0, 6).map((m) => (
                      <div key={m.id} className="flex items-center gap-2 text-xs">
                        <span className="font-mono uppercase text-foreground-faint w-20 shrink-0">{m.status}</span>
                        {m.status === "ready" || m.status === "assigned" ? (
                          m.filePath ? (
                            <a href={`/api/uploads/${m.filePath}`} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2">
                              {t("aikhMediaOpen")}
                            </a>
                          ) : null
                        ) : m.status === "failed" ? (
                          <span className="text-warn truncate">{m.failedReason ?? "?"}</span>
                        ) : (
                          <span className="text-foreground-muted truncate">{m.prompt.slice(0, 60)}</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </Card>

      {/* Feedback */}
      {error && <FormError message={error} />}
      {success && <FormSuccess message={success} />}

      {/* Save */}
      <div className="flex justify-end">
        <Button onClick={handleSave} loading={saving}>
          {t("aikhSave")}
        </Button>
      </div>
    </div>
  );
}
