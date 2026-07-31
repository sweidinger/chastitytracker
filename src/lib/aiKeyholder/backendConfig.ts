import { prisma } from "@/lib/prisma";
import { encrypt } from "@/lib/encrypt";

/**
 * KI-Backend — instanzweite Verbindungs-Config der AI-Keyholderin (Singleton `AiBackendConfig#singleton`),
 * analog zu airlock/config.ts. Ersetzt die frueheren PER-USER-Backend-Felder in AiKeyholderConfig
 * (die bleiben als deprecated in der DB liegen, werden aber nicht mehr gelesen/geschrieben).
 * Zwei API-Keys (Anthropic, Media/Novita) werden AES-256-GCM verschluesselt gehalten (encrypt.ts).
 */
const SINGLETON_ID = "singleton";

/** Backend-Felder, wie die Consumer sie erwarten (Typen wie in AiKeyholderConfig). */
export interface AiBackend {
  llmProvider: string;
  ollamaBaseUrl: string | null;
  ollamaModel: string | null;
  anthropicApiKeyEnc: string | null;
  mediaProvider: string;
  comfyUiBaseUrl: string | null;
  mediaApiKeyEnc: string | null;
  mediaModelName: string | null;
  mediaLlmProvider: string;
  mediaLlmBaseUrl: string | null;
  mediaLlmModel: string | null;
}

const DEFAULTS: AiBackend = {
  llmProvider: "anthropic", ollamaBaseUrl: null, ollamaModel: null, anthropicApiKeyEnc: null,
  mediaProvider: "comfyui", comfyUiBaseUrl: null, mediaApiKeyEnc: null, mediaModelName: null,
  mediaLlmProvider: "inherit", mediaLlmBaseUrl: null, mediaLlmModel: null,
};

async function getRow() {
  return prisma.aiBackendConfig.findUnique({ where: { id: SINGLETON_ID } });
}

/** Server-intern: die globalen Backend-Felder zum Ueberlagern der per-User-Config. */
export async function getAiBackend(): Promise<AiBackend> {
  const row = await getRow();
  if (!row) return { ...DEFAULTS };
  return {
    llmProvider: row.llmProvider ?? "anthropic",
    ollamaBaseUrl: row.ollamaBaseUrl,
    ollamaModel: row.ollamaModel,
    anthropicApiKeyEnc: row.anthropicApiKeyEnc,
    mediaProvider: row.mediaProvider ?? "comfyui",
    comfyUiBaseUrl: row.comfyUiBaseUrl,
    mediaApiKeyEnc: row.mediaApiKeyEnc,
    mediaModelName: row.mediaModelName,
    mediaLlmProvider: row.mediaLlmProvider ?? "inherit",
    mediaLlmBaseUrl: row.mediaLlmBaseUrl,
    mediaLlmModel: row.mediaLlmModel,
  };
}

/** Frontend-sichere Sicht (nie die verschluesselten Keys, nur ob gesetzt). */
export interface AiBackendSafe {
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

export async function getAiBackendSafe(): Promise<AiBackendSafe> {
  const b = await getAiBackend();
  return {
    llmProvider: b.llmProvider,
    ollamaBaseUrl: b.ollamaBaseUrl,
    ollamaModel: b.ollamaModel,
    anthropicApiKeySet: !!b.anthropicApiKeyEnc || !!process.env.ANTHROPIC_API_KEY,
    mediaProvider: b.mediaProvider,
    comfyUiBaseUrl: b.comfyUiBaseUrl,
    mediaApiKeySet: !!b.mediaApiKeyEnc,
    mediaModelName: b.mediaModelName,
    mediaLlmProvider: b.mediaLlmProvider,
    mediaLlmBaseUrl: b.mediaLlmBaseUrl,
    mediaLlmModel: b.mediaLlmModel,
  };
}

function trimUrl(v: string | null | undefined): string | null {
  const s = (v ?? "").trim().replace(/\/+$/, "");
  return s === "" ? null : s;
}
function emptyNull(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s === "" ? null : s;
}

/** Config schreiben (Upsert Singleton). Keys: undefined=unveraendert, ""=loeschen, sonst verschluesseln. */
export async function saveAiBackendConfig(patch: {
  llmProvider?: string;
  ollamaBaseUrl?: string | null;
  ollamaModel?: string | null;
  anthropicApiKey?: string;
  mediaProvider?: string;
  comfyUiBaseUrl?: string | null;
  mediaApiKey?: string;
  mediaModelName?: string | null;
  mediaLlmProvider?: string;
  mediaLlmBaseUrl?: string | null;
  mediaLlmModel?: string | null;
}): Promise<AiBackendSafe> {
  const data: Record<string, unknown> = {};
  if (patch.llmProvider !== undefined) data.llmProvider = patch.llmProvider;
  if ("ollamaBaseUrl" in patch) data.ollamaBaseUrl = trimUrl(patch.ollamaBaseUrl);
  if ("ollamaModel" in patch) data.ollamaModel = emptyNull(patch.ollamaModel);
  if ("anthropicApiKey" in patch && patch.anthropicApiKey !== undefined) {
    data.anthropicApiKeyEnc = patch.anthropicApiKey === "" ? null : encrypt(patch.anthropicApiKey);
  }
  if (patch.mediaProvider !== undefined) data.mediaProvider = patch.mediaProvider;
  if ("comfyUiBaseUrl" in patch) data.comfyUiBaseUrl = trimUrl(patch.comfyUiBaseUrl);
  if ("mediaApiKey" in patch && patch.mediaApiKey !== undefined) {
    data.mediaApiKeyEnc = patch.mediaApiKey === "" ? null : encrypt(patch.mediaApiKey);
  }
  if ("mediaModelName" in patch) data.mediaModelName = emptyNull(patch.mediaModelName);
  if (patch.mediaLlmProvider !== undefined) data.mediaLlmProvider = patch.mediaLlmProvider;
  if ("mediaLlmBaseUrl" in patch) data.mediaLlmBaseUrl = trimUrl(patch.mediaLlmBaseUrl);
  if ("mediaLlmModel" in patch) data.mediaLlmModel = emptyNull(patch.mediaLlmModel);
  await prisma.aiBackendConfig.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, ...data },
    update: data,
  });
  return getAiBackendSafe();
}
