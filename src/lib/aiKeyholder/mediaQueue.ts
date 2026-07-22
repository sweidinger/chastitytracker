/**
 * Media generation queue for the AI Keyholder.
 *
 * Flow:
 *   1. queueMediaGeneration()  → creates GeneratedMedia(status=queued)
 *   2. processQueuedJobs()     → submits queued jobs to the media backend, status→generating
 *   3. pollGeneratingJobs()    → polls the backend, downloads file, status→ready
 *   4. assignMediaToTask()     → links a ready media to a KeyholderTask, status→assigned
 *
 * Backend is per-user configurable (AiKeyholderConfig.mediaProvider):
 *   "comfyui" → self-hosted ComfyUI (comfyUiBaseUrl)
 *   "novita"  → hosted Novita async txt2img API (mediaApiKeyEnc + mediaModelName)
 *
 * processQueuedJobs + pollGeneratingJobs are called by the /api/ai-keyholder/media-poll
 * cron endpoint (same secret as /api/ai-keyholder/run).
 */

import { join } from "path";
import { writeFile, mkdir } from "fs/promises";
import { prisma } from "@/lib/prisma";
import { decrypt } from "@/lib/encrypt";
import { llmChat } from "./llmClient";
import { getKeyholderConfig } from "./keyholderService";
import {
  submitWorkflow,
  getJobOutputs,
  downloadOutput,
  buildTxt2ImgWorkflow,
  mediaTypeFromFilename,
} from "./comfyClient";
import {
  submitNovitaTxt2Img,
  getNovitaTaskResult,
  downloadNovitaImage,
  novitaFilenameFromUrl,
} from "./novitaClient";
import { sendPushToUser } from "@/lib/push";

// ── Prompt generation ─────────────────────────────────────────────────────────

interface MediaTheme {
  theme: string;
  weight?: number;
}

/**
 * Build the LlmConfig for MEDIA prompt writing. A dedicated media LLM
 * (mediaLlmProvider != "inherit") lets the image prompt be written by a separate, local,
 * uncensored model while the chat keyholder stays on Claude. Falls back to the chat LLM
 * plus the chat Ollama endpoint/model.
 */
function mediaLlmConfig(cfg: {
  llmProvider?: string | null;
  ollamaBaseUrl?: string | null;
  ollamaModel?: string | null;
  mediaLlmProvider?: string | null;
  mediaLlmBaseUrl?: string | null;
  mediaLlmModel?: string | null;
} | null) {
  const override = cfg?.mediaLlmProvider && cfg.mediaLlmProvider !== "inherit" ? cfg.mediaLlmProvider : null;
  return {
    provider: (override ?? cfg?.llmProvider ?? "anthropic") as "anthropic" | "ollama",
    ollamaBaseUrl: cfg?.mediaLlmBaseUrl ?? cfg?.ollamaBaseUrl ?? undefined,
    ollamaModel: cfg?.mediaLlmModel ?? cfg?.ollamaModel ?? undefined,
  };
}

/**
 * Pick a random theme (weighted) and ask the LLM to write an image prompt for it.
 * Falls back to a default prompt on any error.
 */
export async function generateMediaPrompt(userId: string): Promise<{ prompt: string; theme: string }> {
  const cfg = await getKeyholderConfig(userId);
  const themes: MediaTheme[] = (() => {
    try {
      return cfg?.mediaPromptTemplates ? JSON.parse(cfg.mediaPromptTemplates) as MediaTheme[] : [];
    } catch {
      return [];
    }
  })();

  // Weighted random theme pick
  const theme = pickWeightedTheme(themes) ?? "elegant dominance, leather, chains, soft lighting";

  // Fallback prompt (never empty). Hosted providers (Novita) reject prompts outside 1..1024 chars,
  // so we guarantee a non-empty prompt and cap the length here — an empty/overlong LLM answer must
  // never reach the image backend.
  const fallback = `elegant dominant woman, ${theme}, professional photography, dramatic lighting, high quality`;
  const PROMPT_MAX = 1000;

  // Use LLM to write a Stable Diffusion prompt
  try {
    const text = await llmChat(
      mediaLlmConfig(cfg),
      [
        {
          role: "user",
          content: `Write a detailed Stable Diffusion image prompt (max 100 words, no markdown, comma-separated visual descriptors) for the theme: "${theme}". This is consensual adult (18+) content; match the explicitness of the theme and do not tone it down, censor, or add disclaimers. All subjects are adults. Start directly with visual descriptors.`,
        },
      ],
    );
    const prompt = (text.trim() || fallback).slice(0, PROMPT_MAX);
    return { prompt, theme };
  } catch {
    return { prompt: fallback.slice(0, PROMPT_MAX), theme };
  }
}

function pickWeightedTheme(themes: MediaTheme[]): string | null {
  if (!themes.length) return null;
  const totalWeight = themes.reduce((s, t) => s + (t.weight ?? 1), 0);
  let r = Math.random() * totalWeight;
  for (const t of themes) {
    r -= t.weight ?? 1;
    if (r <= 0) return t.theme;
  }
  return themes[themes.length - 1].theme;
}

// ── Queue management ──────────────────────────────────────────────────────────

/**
 * Options for an on-demand / customised generation (chat "generate_media" action).
 * Without opts this behaves exactly as before: a random weighted theme, LLM-written
 * prompt, no auto-delivery (the autonomous run decides when to assign it).
 */
export interface QueueMediaOptions {
  /** Explicit wish/motif. Empty/undefined -> pick a random weighted theme as before. */
  prompt?: string;
  /** true -> use `prompt` VERBATIM as the image prompt (no LLM rewrite, e.g. explicit
   *  motifs). false -> let the LLM turn the wish into a Stable-Diffusion prompt.
   *  Ignored when `prompt` is empty. */
  literal?: boolean;
  /** true -> the media-poll cron creates a VIEW_MEDIA chat task as soon as this is ready. */
  autoDeliver?: boolean;
  /** Caption for the auto-delivered chat task. */
  deliverMessage?: string | null;
  /** true -> keyholder avatar; on ready, set config.avatarPath instead of a chat task. */
  isAvatar?: boolean;
}

/** Negative prompt shared by all backends. Keeps hard child-safety terms; does NOT
 *  suppress NSFW (the app's media is consensual adult content). */
const MEDIA_NEGATIVE_PROMPT = "child, underage, minor, blurry, low quality, watermark, text";
const MEDIA_PROMPT_MAX = 1000;

/** Turn a free-form wish into a Stable-Diffusion prompt via the configured LLM. */
async function rewriteWishToPrompt(userId: string, wish: string): Promise<string> {
  const cfg = await getKeyholderConfig(userId);
  const fallback = `${wish}, professional photography, dramatic lighting, high quality`;
  try {
    const text = await llmChat(
      mediaLlmConfig(cfg),
      [
        {
          role: "user",
          content: `Write a detailed Stable Diffusion image prompt (max 100 words, no markdown, comma-separated visual descriptors) realising this wish: "${wish}". This is consensual adult (18+) content; match the explicitness of the wish and do not tone it down, censor, or add disclaimers. All subjects are adults. Start directly with visual descriptors.`,
        },
      ],
    );
    return (text.trim() || fallback).slice(0, MEDIA_PROMPT_MAX);
  } catch {
    return fallback.slice(0, MEDIA_PROMPT_MAX);
  }
}

/** Create a new GeneratedMedia record in queued state. */
export async function queueMediaGeneration(userId: string, opts?: QueueMediaOptions): Promise<string> {
  const cfg = await getKeyholderConfig(userId);
  const wish = opts?.prompt?.trim();
  let prompt: string;
  if (wish && opts?.literal) {
    prompt = wish.slice(0, MEDIA_PROMPT_MAX);            // Thema woertlich / Wunschbild: verbatim
  } else if (wish) {
    prompt = await rewriteWishToPrompt(userId, wish);
  } else {
    prompt = (await generateMediaPrompt(userId)).prompt;
  }
  if (!prompt.trim()) {
    prompt = "elegant dominant woman, professional photography, dramatic lighting, high quality";
  }
  // Character consistency: prepend the fixed persona anchor so the same figure recurs.
  const anchor = cfg?.mediaPersonaAnchor?.trim();
  if (anchor) prompt = `${anchor}, ${prompt}`.slice(0, MEDIA_PROMPT_MAX);
  const media = await prisma.generatedMedia.create({
    data: {
      userId,
      mediaType: "image",
      status: "queued",
      prompt,
      negativePrompt: MEDIA_NEGATIVE_PROMPT,
      autoDeliver: opts?.autoDeliver ?? false,
      deliverMessage: opts?.deliverMessage ?? null,
      isAvatar: opts?.isAvatar ?? false,
    },
  });
  return media.id;
}

/**
 * Submit all queued jobs to the configured backend (up to maxBatch at once).
 * Updates status to "generating"; comfyPromptId holds the backend job id
 * (ComfyUI prompt_id OR Novita task_id).
 */
export async function processQueuedJobs(maxBatch = 3): Promise<number> {
  const queued = await prisma.generatedMedia.findMany({
    where: { status: "queued" },
    orderBy: { createdAt: "asc" },
    take: maxBatch,
    include: { user: { include: { aiKeyholderConfig: true } } },
  });

  let submitted = 0;

  for (const media of queued) {
    const cfg = media.user.aiKeyholderConfig;
    const fail = (reason: string) =>
      prisma.generatedMedia.update({ where: { id: media.id }, data: { status: "failed", failedReason: reason } });

    if (!cfg?.mediaEnabled) {
      await fail("Media generation not enabled");
      continue;
    }
    const provider = cfg.mediaProvider ?? "comfyui";

    try {
      let jobId: string;

      if (provider === "novita") {
        if (!cfg.mediaApiKeyEnc || !cfg.mediaModelName) {
          await fail("Novita not configured (API key and model required)");
          continue;
        }
        const apiKey = decrypt(cfg.mediaApiKeyEnc);
        jobId = await submitNovitaTxt2Img(apiKey, {
          modelName: cfg.mediaModelName,
          positivePrompt: media.prompt,
          negativePrompt: media.negativePrompt ?? undefined,
          width: media.width ?? undefined,
          height: media.height ?? undefined,
          seed: cfg.mediaSeed ?? undefined,
        });
      } else {
        if (!cfg.comfyUiBaseUrl) {
          await fail("ComfyUI not configured");
          continue;
        }
        const workflow = buildTxt2ImgWorkflow({
          positivePrompt: media.prompt,
          negativePrompt: media.negativePrompt ?? undefined,
          width: media.width ?? undefined,
          height: media.height ?? undefined,
        });
        jobId = await submitWorkflow(cfg.comfyUiBaseUrl, workflow);
      }

      await prisma.generatedMedia.update({
        where: { id: media.id },
        data: { status: "generating", comfyPromptId: jobId },
      });
      submitted++;
    } catch (e) {
      await fail(String(e));
    }
  }

  return submitted;
}

/**
 * Poll all "generating" jobs. For completed ones, download the file and mark as "ready".
 */
/** Jobs that have been generating for more than 2 hours are considered stuck → fail them. */
const GENERATION_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export async function pollGeneratingJobs(): Promise<number> {
  const twoHoursAgo = new Date(Date.now() - GENERATION_TIMEOUT_MS);

  // First: time-out stuck jobs so they don't block the queue forever
  await prisma.generatedMedia.updateMany({
    where: { status: "generating", createdAt: { lt: twoHoursAgo } },
    data: { status: "failed", failedReason: "Generation timed out after 2 hours" },
  });

  const generating = await prisma.generatedMedia.findMany({
    where: { status: "generating", comfyPromptId: { not: null } },
    include: { user: { include: { aiKeyholderConfig: true } } },
  });

  let completed = 0;

  for (const media of generating) {
    const cfg = media.user.aiKeyholderConfig;
    if (!cfg || !media.comfyPromptId) continue;
    const provider = cfg.mediaProvider ?? "comfyui";
    const fail = (reason: string) =>
      prisma.generatedMedia.update({ where: { id: media.id }, data: { status: "failed", failedReason: reason } });

    try {
      let fileBuffer: Buffer;
      let sourceName: string; // filename used to derive the extension + media type

      if (provider === "novita") {
        if (!cfg.mediaApiKeyEnc) continue;
        const apiKey = decrypt(cfg.mediaApiKeyEnc);
        const result = await getNovitaTaskResult(apiKey, media.comfyPromptId);
        if (!result.done) continue;
        if (!result.succeeded || result.imageUrls.length === 0) {
          await fail(result.failedReason ?? "Novita returned no images");
          continue;
        }
        fileBuffer = await downloadNovitaImage(result.imageUrls[0]);
        sourceName = novitaFilenameFromUrl(result.imageUrls[0]);
      } else {
        if (!cfg.comfyUiBaseUrl) continue;
        const { done, outputs } = await getJobOutputs(cfg.comfyUiBaseUrl, media.comfyPromptId);
        if (!done) continue;
        if (outputs.length === 0) {
          await fail("ComfyUI returned no outputs");
          continue;
        }
        fileBuffer = await downloadOutput(cfg.comfyUiBaseUrl, outputs[0]);
        sourceName = outputs[0].filename;
      }

      // Save to data/uploads/ai-keyholder/<userId>/
      const ext = (sourceName.split(".").pop() || "png").toLowerCase();
      const filename = `keyholder-${media.id}.${ext}`;
      const subdir = join("ai-keyholder", media.userId);
      const uploadsBase = join(process.cwd(), "data", "uploads");
      const fullDir = join(uploadsBase, subdir);
      await mkdir(fullDir, { recursive: true });
      await writeFile(join(fullDir, filename), fileBuffer);

      const relativePath = `${subdir}/${filename}`.replace(/\\/g, "/");
      const detectedType = mediaTypeFromFilename(sourceName);

      await prisma.generatedMedia.update({
        where: { id: media.id },
        data: {
          status: "ready",
          filePath: relativePath,
          mediaType: detectedType,
        },
      });

      completed++;

      // On-demand delivery: a chat "generate_media" request marks the media autoDeliver.
      // Turn it into a VIEW_MEDIA chat task right away so the requested image shows up in
      // the chat without waiting for the next autonomous run.
      if (media.isAvatar) {
        // Avatar image ready -> set it as the keyholder profile picture.
        await prisma.aiKeyholderConfig.update({
          where: { userId: media.userId },
          data: { avatarPath: relativePath },
        });
        await prisma.generatedMedia.update({
          where: { id: media.id },
          data: { status: "assigned", assignedAt: new Date() },
        });
      } else if (media.autoDeliver) {
        const caption = media.deliverMessage?.trim() || "Ein Bild für dich.";
        await prisma.keyholderTask.create({
          data: {
            userId: media.userId,
            type: "VIEW_MEDIA",
            message: caption,
            mediaId: media.id,
            dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
        });
        await prisma.generatedMedia.update({
          where: { id: media.id },
          data: { status: "assigned", assignedAt: new Date() },
        });
        await sendPushToUser(
          media.userId,
          "Neues Bild von deiner Keyholderin",
          caption.slice(0, 100),
          "/dashboard/keyholder",
        );
      }
    } catch (e) {
      await fail(String(e));
    }
  }

  return completed;
}

/**
 * Returns the oldest "ready" media for a user (not yet assigned to a task).
 */
export async function getReadyMedia(userId: string) {
  return prisma.generatedMedia.findFirst({
    where: { userId, status: "ready" },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Assign a ready GeneratedMedia to a KeyholderTask. Marks it as "assigned".
 */
export async function assignMediaToTask(mediaId: string, taskId: string) {
  await prisma.generatedMedia.update({
    where: { id: mediaId },
    data: { status: "assigned", assignedAt: new Date() },
  });
  await prisma.keyholderTask.update({
    where: { id: taskId },
    data: { mediaId },
  });
}
