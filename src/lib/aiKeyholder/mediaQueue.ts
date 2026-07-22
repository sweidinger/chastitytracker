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

// ── Prompt generation ─────────────────────────────────────────────────────────

interface MediaTheme {
  theme: string;
  weight?: number;
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

  // Use LLM to write a Stable Diffusion prompt
  try {
    const text = await llmChat(
      {
        provider: (cfg?.llmProvider ?? "anthropic") as "anthropic" | "ollama",
        ollamaBaseUrl: cfg?.ollamaBaseUrl ?? undefined,
        ollamaModel: cfg?.ollamaModel ?? undefined,
      },
      [
        {
          role: "user",
          content: `Write a Stable Diffusion image prompt (max 100 words, no markdown) for the theme: "${theme}". The prompt must be for an artistic, tasteful adult image. Start directly with visual descriptors.`,
        },
      ],
    );
    return { prompt: text.trim(), theme };
  } catch {
    return {
      prompt: `elegant dominant woman, ${theme}, professional photography, dramatic lighting, high quality`,
      theme,
    };
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

/** Create a new GeneratedMedia record in queued state. */
export async function queueMediaGeneration(userId: string): Promise<string> {
  const { prompt, theme } = await generateMediaPrompt(userId);
  const media = await prisma.generatedMedia.create({
    data: {
      userId,
      mediaType: "image",
      status: "queued",
      prompt,
      negativePrompt: "nsfw, child, underage, blurry, low quality, watermark, text",
    },
  });
  void theme; // captured in prompt text
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
