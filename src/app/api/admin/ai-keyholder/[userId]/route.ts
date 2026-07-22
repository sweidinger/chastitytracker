import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/authGuards";
import { encrypt } from "@/lib/encrypt";

/**
 * GET /api/admin/ai-keyholder/[userId]
 * Returns the AiKeyholderConfig for the given user (or null if not yet created).
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const err = await requireAdminApi();
  if (err) return err;

  const { userId } = await params;
  const config = await prisma.aiKeyholderConfig.findUnique({ where: { userId } });

  // Never return the encrypted keys — expose only whether they are set
  if (config) {
    const { anthropicApiKeyEnc, mediaApiKeyEnc, ...safeConfig } = config;
    return NextResponse.json({
      config: { ...safeConfig, anthropicApiKeySet: !!anthropicApiKeyEnc, mediaApiKeySet: !!mediaApiKeyEnc },
    });
  }
  return NextResponse.json({ config: null });
}

/**
 * PATCH /api/admin/ai-keyholder/[userId]
 * Upserts the AiKeyholderConfig for the given user.
 * Accepts a partial body — only provided fields are updated.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const err = await requireAdminApi();
  if (err) return err;

  const { userId } = await params;

  // Ensure the target user exists
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const body = await req.json() as {
    enabled?: boolean;
    llmProvider?: string;
    ollamaBaseUrl?: string | null;
    ollamaModel?: string | null;
    systemPrompt?: string | null;
    intensity?: number | null;
    proactiveCheckinMinHours?: number | null;
    visionEnabled?: boolean;
    cronExpression?: string | null;
    randomIntervalMinMin?: number | null;
    randomIntervalMinMax?: number | null;
    mediaEnabled?: boolean;
    comfyUiBaseUrl?: string | null;
    mediaPromptTemplates?: string | null;
    /** Media backend: "comfyui" (self-hosted) | "novita" (hosted API). */
    mediaProvider?: string;
    /** Novita checkpoint filename (model_name), e.g. "sd_xl_base_1.0.safetensors". */
    mediaModelName?: string | null;
    /** Dedicated media-prompt LLM: "inherit" | "anthropic" | "ollama". */
    mediaLlmProvider?: string;
    mediaLlmBaseUrl?: string | null;
    mediaLlmModel?: string | null;
    /** Plain-text media (Novita) API key; empty string = clear stored key. */
    mediaApiKey?: string;
    /** Plain-text Anthropic API key; empty string = clear stored key */
    anthropicApiKey?: string;
    /** Persona ID to link; null = clear current persona assignment */
    personaId?: string | null;
  };

  // Only pick known fields to avoid mass-assignment
  const data: Record<string, unknown> = {};
  if (body.enabled !== undefined) data.enabled = body.enabled;
  if (body.llmProvider !== undefined) {
    if (!["anthropic", "ollama"].includes(body.llmProvider)) {
      return NextResponse.json({ error: "llmProvider must be 'anthropic' or 'ollama'" }, { status: 400 });
    }
    data.llmProvider = body.llmProvider;
  }
  if ("ollamaBaseUrl" in body) data.ollamaBaseUrl = body.ollamaBaseUrl ?? null;
  if ("ollamaModel" in body) data.ollamaModel = body.ollamaModel ?? null;
  if ("systemPrompt" in body) data.systemPrompt = body.systemPrompt ?? null;
  if (typeof body.intensity === "number") data.intensity = Math.max(1, Math.min(5, Math.round(body.intensity)));
  // Nur die erlaubten Check-in-Stufen (0=aus / 3 / 6 / 12 / 24 Std) zulassen; sonst Standard 24.
  if (typeof body.proactiveCheckinMinHours === "number") {
    data.proactiveCheckinMinHours = [0, 3, 6, 12, 24].includes(body.proactiveCheckinMinHours) ? body.proactiveCheckinMinHours : 24;
  }
  if (typeof body.visionEnabled === "boolean") data.visionEnabled = body.visionEnabled;
  if ("cronExpression" in body) data.cronExpression = body.cronExpression ?? null;
  if ("randomIntervalMinMin" in body) data.randomIntervalMinMin = body.randomIntervalMinMin ?? null;
  if ("randomIntervalMinMax" in body) data.randomIntervalMinMax = body.randomIntervalMinMax ?? null;
  if (body.mediaEnabled !== undefined) data.mediaEnabled = body.mediaEnabled;
  if ("comfyUiBaseUrl" in body) data.comfyUiBaseUrl = body.comfyUiBaseUrl ?? null;
  if ("mediaPromptTemplates" in body) data.mediaPromptTemplates = body.mediaPromptTemplates ?? null;
  if (body.mediaProvider !== undefined) {
    if (!["comfyui", "novita"].includes(body.mediaProvider)) {
      return NextResponse.json({ error: "mediaProvider must be 'comfyui' or 'novita'" }, { status: 400 });
    }
    data.mediaProvider = body.mediaProvider;
  }
  if ("mediaModelName" in body) data.mediaModelName = body.mediaModelName ?? null;
  if (body.mediaLlmProvider !== undefined) {
    if (!["inherit", "anthropic", "ollama"].includes(body.mediaLlmProvider)) {
      return NextResponse.json({ error: "mediaLlmProvider must be 'inherit', 'anthropic' or 'ollama'" }, { status: 400 });
    }
    data.mediaLlmProvider = body.mediaLlmProvider;
  }
  if ("mediaLlmBaseUrl" in body) data.mediaLlmBaseUrl = body.mediaLlmBaseUrl ?? null;
  if ("mediaLlmModel" in body) data.mediaLlmModel = body.mediaLlmModel ?? null;
  if ("personaId" in body) data.currentPersonaId = body.personaId ?? null;

  // Encrypt Anthropic API key if provided; empty string clears the stored value
  if ("anthropicApiKey" in body) {
    const raw = body.anthropicApiKey ?? "";
    data.anthropicApiKeyEnc = raw === "" ? null : encrypt(raw);
  }
  // Encrypt media (Novita) API key if provided; empty string clears the stored value
  if ("mediaApiKey" in body) {
    const raw = body.mediaApiKey ?? "";
    data.mediaApiKeyEnc = raw === "" ? null : encrypt(raw);
  }

  const config = await prisma.aiKeyholderConfig.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });

  // Never return the encrypted keys
  const { anthropicApiKeyEnc, mediaApiKeyEnc, ...safeConfig } = config;
  return NextResponse.json({
    config: { ...safeConfig, anthropicApiKeySet: !!anthropicApiKeyEnc, mediaApiKeySet: !!mediaApiKeyEnc },
  });
}
