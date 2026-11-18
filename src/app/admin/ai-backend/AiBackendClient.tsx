"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import Card from "@/app/components/Card";
import Button from "@/app/components/Button";
import Input from "@/app/components/Input";
import Select from "@/app/components/Select";
import FormError from "@/app/components/FormError";
import FormSuccess from "@/app/components/FormSuccess";
import { Save } from "lucide-react";

interface BackendSafe {
  llmProvider: string;
  ollamaBaseUrl: string | null;
  ollamaModel: string | null;
  anthropicApiKeySet: boolean;
  mediaProvider: string;
  comfyUiBaseUrl: string | null;
  mediaApiKeySet: boolean;
  mediaModelName: string | null;
  mediaLlmProvider: string;
  mediaLlmBaseUrl: string | null;
  mediaLlmModel: string | null;
}

export default function AiBackendClient({ initial }: { initial: BackendSafe }) {
  const t = useTranslations("admin");

  const [llmProvider, setLlmProvider] = useState(initial.llmProvider ?? "anthropic");
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState(initial.ollamaBaseUrl ?? "");
  const [ollamaModel, setOllamaModel] = useState(initial.ollamaModel ?? "qwen2.5:32b");
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [anthropicApiKeySet, setAnthropicApiKeySet] = useState(initial.anthropicApiKeySet);
  const [clearApiKey, setClearApiKey] = useState(false);

  const [mediaProvider, setMediaProvider] = useState(initial.mediaProvider ?? "comfyui");
  const [comfyUiBaseUrl, setComfyUiBaseUrl] = useState(initial.comfyUiBaseUrl ?? "");
  const [mediaApiKey, setMediaApiKey] = useState("");
  const [mediaApiKeySet, setMediaApiKeySet] = useState(initial.mediaApiKeySet);
  const [clearMediaKey, setClearMediaKey] = useState(false);
  const [mediaModelName, setMediaModelName] = useState(initial.mediaModelName ?? "");

  const [mediaLlmProvider, setMediaLlmProvider] = useState(initial.mediaLlmProvider ?? "inherit");
  const [mediaLlmBaseUrl, setMediaLlmBaseUrl] = useState(initial.mediaLlmBaseUrl ?? "");
  const [mediaLlmModel, setMediaLlmModel] = useState(initial.mediaLlmModel ?? "");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleSave() {
    setError(null);
    setSuccess(null);
    setSaving(true);
    try {
      const res = await fetch("/api/admin/ai-backend/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          llmProvider,
          ollamaBaseUrl: llmProvider === "ollama" ? (ollamaBaseUrl || null) : null,
          ollamaModel: llmProvider === "ollama" ? (ollamaModel || null) : null,
          mediaProvider,
          comfyUiBaseUrl: mediaProvider === "comfyui" ? (comfyUiBaseUrl || null) : null,
          mediaModelName: mediaProvider === "novita" ? (mediaModelName || null) : null,
          mediaLlmProvider,
          mediaLlmBaseUrl: mediaLlmProvider === "ollama" ? (mediaLlmBaseUrl || null) : null,
          mediaLlmModel: mediaLlmProvider === "ollama" ? (mediaLlmModel || null) : null,
          ...(clearApiKey ? { anthropicApiKey: "" } : anthropicApiKey !== "" ? { anthropicApiKey } : {}),
          ...(clearMediaKey ? { mediaApiKey: "" } : mediaApiKey !== "" ? { mediaApiKey } : {}),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? t("aiBackendSaveFailed"));
      }
      const { config } = (await res.json()) as { config: BackendSafe };
      setAnthropicApiKeySet(config.anthropicApiKeySet);
      setMediaApiKeySet(config.mediaApiKeySet);
      setAnthropicApiKey("");
      setMediaApiKey("");
      setClearApiKey(false);
      setClearMediaKey(false);
      setSuccess(t("aiBackendSaved"));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="mb-1">
        <h2 className="text-base font-semibold text-foreground">{t("aiBackendPageTitle")}</h2>
        <p className="text-sm text-foreground-muted mt-0.5">{t("aiBackendPageDesc")}</p>
      </div>

      {/* LLM-Chat-Backend */}
      <Card>
        <div className="flex flex-col gap-4">
          <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">{t("aiBackendSectionLlm")}</h3>
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
                placeholder={anthropicApiKeySet ? t("aikhAnthropicApiKeySet") : t("aikhAnthropicApiKeyPlaceholder")}
                hint={t("aikhAnthropicApiKeyHint")}
                value={anthropicApiKey}
                onChange={(e) => { setAnthropicApiKey(e.target.value); if (e.target.value) setClearApiKey(false); }}
                autoComplete="off"
                disabled={clearApiKey}
              />
              {anthropicApiKeySet && (
                <label className="flex items-center gap-2 text-xs text-foreground-muted">
                  <input type="checkbox" checked={clearApiKey} onChange={(e) => { setClearApiKey(e.target.checked); if (e.target.checked) setAnthropicApiKey(""); }} />
                  {t("aikhAnthropicApiKeyClear")}
                </label>
              )}
            </div>
          )}
          {llmProvider === "ollama" && (
            <>
              <Input label={t("aikhOllamaUrl")} placeholder="http://192.168.1.10:11434" value={ollamaBaseUrl} onChange={(e) => setOllamaBaseUrl(e.target.value)} />
              <Input label={t("aikhOllamaModel")} placeholder="qwen2.5:32b" value={ollamaModel} onChange={(e) => setOllamaModel(e.target.value)} />
            </>
          )}
        </div>
      </Card>

      {/* Medien-Backend */}
      <Card>
        <div className="flex flex-col gap-4">
          <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">{t("aiBackendSectionMedia")}</h3>
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
            <Input label={t("aikhComfyUrl")} placeholder="http://192.168.1.10:8188" value={comfyUiBaseUrl} onChange={(e) => setComfyUiBaseUrl(e.target.value)} />
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
                  onChange={(e) => { setMediaApiKey(e.target.value); if (e.target.value) setClearMediaKey(false); }}
                  autoComplete="off"
                  disabled={clearMediaKey}
                />
                {mediaApiKeySet && (
                  <label className="flex items-center gap-2 text-xs text-foreground-muted">
                    <input type="checkbox" checked={clearMediaKey} onChange={(e) => { setClearMediaKey(e.target.checked); if (e.target.checked) setMediaApiKey(""); }} />
                    {t("aikhAnthropicApiKeyClear")}
                  </label>
                )}
              </div>
              <Input label={t("aikhMediaModelName")} placeholder="sd_xl_base_1.0.safetensors" hint={t("aikhMediaModelNameHint")} value={mediaModelName} onChange={(e) => setMediaModelName(e.target.value)} />
            </>
          )}
        </div>
      </Card>

      {/* Medien-Prompt-LLM */}
      <Card>
        <div className="flex flex-col gap-4">
          <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">{t("aiBackendSectionMediaLlm")}</h3>
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
              <Input label={t("aikhMediaLlmUrl")} placeholder="http://192.168.1.10:11434" value={mediaLlmBaseUrl} onChange={(e) => setMediaLlmBaseUrl(e.target.value)} />
              <Input label={t("aikhMediaLlmModel")} placeholder="dolphin-mistral" hint={t("aikhMediaLlmModelHint")} value={mediaLlmModel} onChange={(e) => setMediaLlmModel(e.target.value)} />
            </>
          )}
        </div>
      </Card>

      <FormError message={error} />
      <FormSuccess message={success} />
      <div>
        <Button variant="primary" loading={saving} onClick={handleSave} icon={<Save size={16} />}>
          {t("aiBackendSave")}
        </Button>
      </div>
    </div>
  );
}
