/**
 * Novita AI hosted text-to-image client (async task API).
 *
 * Novita exposes:
 *   POST /v3/async/txt2img              → submit, returns { task_id }
 *   GET  /v3/async/task-result?task_id  → poll status + result image URLs
 *
 * Auth: Bearer <API key>. Docs: https://novita.ai/docs/api-reference/model-apis-text-to-image
 * NSFW detection is opt-in (enable_nsfw_detection) and intentionally left OFF here.
 */

const NOVITA_BASE = "https://api.novita.ai";

export interface NovitaTxt2ImgOptions {
  /** Checkpoint filename as listed in Novita's model registry (model_name). */
  modelName: string;
  positivePrompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  guidanceScale?: number;
  samplerName?: string;
  /** -1 = random. */
  seed?: number;
}

/** Submit a txt2img job and return the Novita task_id. */
export async function submitNovitaTxt2Img(apiKey: string, opts: NovitaTxt2ImgOptions): Promise<string> {
  // Novita rejects prompts outside 1..1024 chars (VALIDATOR error) — clamp defensively.
  const prompt = (opts.positivePrompt || "").trim().slice(0, 1024);
  if (!prompt) throw new Error("Novita txt2img: empty prompt");
  const negativePrompt = (opts.negativePrompt ?? "child, underage, blurry, low quality, watermark, text").slice(0, 1024);
  const res = await fetch(`${NOVITA_BASE}/v3/async/txt2img`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      request: {
        model_name: opts.modelName,
        prompt,
        negative_prompt: negativePrompt,
        width: opts.width ?? 832,
        height: opts.height ?? 1216,
        image_num: 1,
        steps: opts.steps ?? 25,
        guidance_scale: opts.guidanceScale ?? 6,
        sampler_name: opts.samplerName ?? "Euler a",
        seed: opts.seed ?? -1,
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Novita /txt2img error ${res.status}: ${text}`);
  }
  const data = await res.json() as { task_id?: string };
  if (!data.task_id) throw new Error("Novita returned no task_id");
  return data.task_id;
}

export interface NovitaResult {
  /** Terminal state reached (succeeded or failed). */
  done: boolean;
  succeeded: boolean;
  imageUrls: string[];
  failedReason?: string;
}

/** Poll a Novita task. Returns done=false while still queued/running. */
export async function getNovitaTaskResult(apiKey: string, taskId: string): Promise<NovitaResult> {
  const res = await fetch(`${NOVITA_BASE}/v3/async/task-result?task_id=${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Novita /task-result error ${res.status}`);
  const data = await res.json() as {
    task?: { status?: string; reason?: string };
    images?: { image_url?: string }[];
  };
  const status = data.task?.status ?? "";
  if (status === "TASK_STATUS_SUCCEED") {
    const imageUrls = (data.images ?? []).map((i) => i.image_url).filter((u): u is string => !!u);
    return { done: true, succeeded: true, imageUrls };
  }
  if (status === "TASK_STATUS_FAILED") {
    return { done: true, succeeded: false, imageUrls: [], failedReason: data.task?.reason ?? "Novita task failed" };
  }
  return { done: false, succeeded: false, imageUrls: [] };
}

/** Download a generated image from its (pre-signed) result URL. */
export async function downloadNovitaImage(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Novita image download error ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Filename (for extension detection) from a Novita image URL, stripping the query string. */
export function novitaFilenameFromUrl(url: string): string {
  const path = url.split("?")[0];
  return path.split("/").pop() || "novita.png";
}
