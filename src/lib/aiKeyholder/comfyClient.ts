/**
 * Low-level ComfyUI REST API client.
 *
 * ComfyUI exposes:
 *   POST /prompt            – submit a workflow, returns { prompt_id }
 *   GET  /history/{id}      – poll job status + output list
 *   GET  /view?filename=... – download a generated file
 */

export interface ComfyOutput {
  filename: string;
  subfolder: string;
  type: string;  // "output" | "temp"
}

// ── API wrappers ──────────────────────────────────────────────────────────────

/** Submit a workflow and return the ComfyUI prompt_id. */
export async function submitWorkflow(
  baseUrl: string,
  workflow: Record<string, unknown>,
): Promise<string> {
  const res = await fetch(`${baseUrl}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: "kg-keyholder" }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ComfyUI /prompt error ${res.status}: ${text}`);
  }
  const data = await res.json() as { prompt_id: string };
  if (!data.prompt_id) throw new Error("ComfyUI returned no prompt_id");
  return data.prompt_id;
}

/** Poll job status. Returns done=true + outputs when the job is finished. */
export async function getJobOutputs(
  baseUrl: string,
  promptId: string,
): Promise<{ done: boolean; outputs: ComfyOutput[] }> {
  const res = await fetch(`${baseUrl}/history/${encodeURIComponent(promptId)}`);
  if (!res.ok) throw new Error(`ComfyUI /history error ${res.status}`);
  const history = await res.json() as Record<string, {
    outputs: Record<string, { images?: ComfyOutput[]; gifs?: ComfyOutput[]; video?: ComfyOutput[] }>;
    status: { completed: boolean; status_str?: string };
  }>;

  const entry = history[promptId];
  if (!entry) return { done: false, outputs: [] };
  if (!entry.status?.completed) return { done: false, outputs: [] };

  // Collect all image/gif/video outputs from every node
  const outputs: ComfyOutput[] = [];
  for (const nodeOut of Object.values(entry.outputs ?? {})) {
    if (nodeOut.images) outputs.push(...nodeOut.images.filter((o) => o.type === "output"));
    if (nodeOut.gifs)   outputs.push(...nodeOut.gifs.filter((o) => o.type === "output"));
    if (nodeOut.video)  outputs.push(...nodeOut.video.filter((o) => o.type === "output"));
  }

  return { done: true, outputs };
}

/** Download a ComfyUI output file and return its raw bytes. */
export async function downloadOutput(
  baseUrl: string,
  output: ComfyOutput,
): Promise<Buffer> {
  const url = new URL(`${baseUrl}/view`);
  url.searchParams.set("filename", output.filename);
  url.searchParams.set("subfolder", output.subfolder);
  url.searchParams.set("type", output.type);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`ComfyUI /view error ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ── Workflow builder ──────────────────────────────────────────────────────────

export interface Txt2ImgOptions {
  positivePrompt: string;
  negativePrompt?: string;
  /** Checkpoint file name as it appears in ComfyUI's models/checkpoints folder */
  checkpointName?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  seed?: number;
}

/**
 * Build a minimal standard KSampler txt2img workflow compatible with most
 * Stable Diffusion checkpoints in ComfyUI.
 *
 * Node map:
 *   1 → CheckpointLoaderSimple
 *   2 → CLIPTextEncode (positive)
 *   3 → CLIPTextEncode (negative)
 *   4 → EmptyLatentImage
 *   5 → KSampler
 *   6 → VAEDecode
 *   7 → SaveImage
 */
export function buildTxt2ImgWorkflow(opts: Txt2ImgOptions): Record<string, unknown> {
  const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 32);

  return {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: {
        ckpt_name: opts.checkpointName ?? (process.env.COMFYUI_CHECKPOINT ?? "v1-5-pruned-emaonly.safetensors"),
      },
    },
    "2": {
      class_type: "CLIPTextEncode",
      inputs: { text: opts.positivePrompt, clip: ["1", 1] },
    },
    "3": {
      class_type: "CLIPTextEncode",
      inputs: {
        text: opts.negativePrompt ?? "nsfw, child, underage, blurry, low quality, watermark, text",
        clip: ["1", 1],
      },
    },
    "4": {
      class_type: "EmptyLatentImage",
      inputs: { width: opts.width ?? 768, height: opts.height ?? 1024, batch_size: 1 },
    },
    "5": {
      class_type: "KSampler",
      inputs: {
        seed,
        steps: opts.steps ?? 20,
        cfg: opts.cfg ?? 7.0,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1.0,
        model:         ["1", 0],
        positive:      ["2", 0],
        negative:      ["3", 0],
        latent_image:  ["4", 0],
      },
    },
    "6": {
      class_type: "VAEDecode",
      inputs: { samples: ["5", 0], vae: ["1", 2] },
    },
    "7": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "kg-keyholder", images: ["6", 0] },
    },
  };
}

/** Derive media type from a ComfyUI output filename. */
export function mediaTypeFromFilename(filename: string): "image" | "video" {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return ["mp4", "webm", "gif", "mov"].includes(ext) ? "video" : "image";
}
