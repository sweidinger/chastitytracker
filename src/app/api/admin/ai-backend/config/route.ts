import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/authGuards";
import { getAiBackendSafe, saveAiBackendConfig } from "@/lib/aiKeyholder/backendConfig";

export const dynamic = "force-dynamic";

/**
 * GET  /api/admin/ai-backend/config — instanzweite KI-Backend-Config (nie die Keys, nur *Set-Flags).
 * PATCH aktualisiert LLM- + Medien-Verbindung. Leerer Key-String loescht den gespeicherten Key.
 * Global-Admin-only, analog zur Airlock-Config (/api/admin/airlock/config).
 */
export async function GET() {
  const err = await requireAdminApi();
  if (err) return err;
  return NextResponse.json({ config: await getAiBackendSafe() });
}

export async function PATCH(req: Request) {
  const err = await requireAdminApi();
  if (err) return err;

  const body = (await req.json()) as {
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
  };

  const patch: Parameters<typeof saveAiBackendConfig>[0] = {};
  if (body.llmProvider !== undefined) {
    if (!["anthropic", "ollama"].includes(body.llmProvider)) {
      return NextResponse.json({ error: "llmProvider must be 'anthropic' or 'ollama'" }, { status: 400 });
    }
    patch.llmProvider = body.llmProvider;
  }
  if ("ollamaBaseUrl" in body) patch.ollamaBaseUrl = body.ollamaBaseUrl ?? null;
  if ("ollamaModel" in body) patch.ollamaModel = body.ollamaModel ?? null;
  if ("anthropicApiKey" in body && body.anthropicApiKey !== undefined) patch.anthropicApiKey = body.anthropicApiKey;
  if (body.mediaProvider !== undefined) {
    if (!["comfyui", "novita"].includes(body.mediaProvider)) {
      return NextResponse.json({ error: "mediaProvider must be 'comfyui' or 'novita'" }, { status: 400 });
    }
    patch.mediaProvider = body.mediaProvider;
  }
  if ("comfyUiBaseUrl" in body) patch.comfyUiBaseUrl = body.comfyUiBaseUrl ?? null;
  if ("mediaApiKey" in body && body.mediaApiKey !== undefined) patch.mediaApiKey = body.mediaApiKey;
  if ("mediaModelName" in body) patch.mediaModelName = body.mediaModelName ?? null;
  if (body.mediaLlmProvider !== undefined) {
    if (!["inherit", "anthropic", "ollama"].includes(body.mediaLlmProvider)) {
      return NextResponse.json({ error: "mediaLlmProvider must be 'inherit', 'anthropic' or 'ollama'" }, { status: 400 });
    }
    patch.mediaLlmProvider = body.mediaLlmProvider;
  }
  if ("mediaLlmBaseUrl" in body) patch.mediaLlmBaseUrl = body.mediaLlmBaseUrl ?? null;
  if ("mediaLlmModel" in body) patch.mediaLlmModel = body.mediaLlmModel ?? null;

  const config = await saveAiBackendConfig(patch);
  return NextResponse.json({ config });
}
