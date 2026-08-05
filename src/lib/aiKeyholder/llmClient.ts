import Anthropic from "@anthropic-ai/sdk";
import type { ImageMediaType } from "@/lib/imageLoad";

/** Ein Inhaltsblock einer Nachricht: Text oder Bild (base64) — analog zu VisionBlock. */
export type LlmPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: ImageMediaType; base64: string };

export interface LlmMessage {
  role: "user" | "assistant" | "system";
  /** String = reiner Text (Normalfall). Blöcke nur, wenn Bilder mitgeschickt werden. */
  content: string | LlmPart[];
}

export interface LlmConfig {
  provider: "anthropic" | "ollama";
  ollamaBaseUrl?: string | null;
  ollamaModel?: string | null;
  /**
   * Optionales Vision-Modell für Ollama-Turns MIT Bild. Ist es nicht gesetzt, greift
   * die Env AI_KEYHOLDER_OLLAMA_VISION_MODEL (Default qwen2.5vl:7b). So bleibt das
   * Text-Modell (ollamaModel) für den häufigen reinen Text-Chat schnell.
   */
  ollamaVisionModel?: string | null;
  /** Override for ANTHROPIC_API_KEY env var. Decrypted by the caller. */
  anthropicApiKey?: string | null;
}

/** Text einer Nachricht — Bild-Blöcke werden übersprungen (fürs Logging/Speichern). */
export function messageText(content: string | LlmPart[]): string {
  if (typeof content === "string") return content;
  return content.filter((p): p is Extract<LlmPart, { type: "text" }> => p.type === "text").map((p) => p.text).join("\n");
}

/**
 * Send a chat completion request and return the full response text.
 * System messages are handled differently per provider:
 * - Anthropic: system is passed as top-level `system` param
 * - Ollama:    system messages are included inline in the messages array
 */
export async function llmChat(
  config: LlmConfig,
  messages: LlmMessage[],
): Promise<string> {
  if (config.provider === "ollama") {
    return ollamaChat(config, messages);
  }
  return anthropicChat(config, messages);
}

/**
 * Stream a chat completion. Yields text chunks as they arrive.
 * Caller is responsible for flushing chunks to the HTTP response.
 */
export async function* llmStream(
  config: LlmConfig,
  messages: LlmMessage[],
): AsyncGenerator<string> {
  if (config.provider === "ollama") {
    yield* ollamaStream(config, messages);
  } else {
    yield* anthropicStream(config, messages);
  }
}

// ── Anthropic ────────────────────────────────────────────────────────────────

const ANTHROPIC_MODEL = process.env.AI_KEYHOLDER_ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";

/** Returns an Anthropic client using config.anthropicApiKey if set, else the env var. */
function getAnthropicClient(config: LlmConfig): Anthropic {
  const apiKey = config.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  return new Anthropic({ apiKey });
}

/** Blöcke → Anthropic-Content. Reiner Text bleibt ein String (identisch zum bisherigen Verhalten). */
function toAnthropicContent(content: string | LlmPart[]): Anthropic.MessageParam["content"] {
  if (typeof content === "string") return content;
  return content.map((p) =>
    p.type === "text"
      ? ({ type: "text", text: p.text } as const)
      : ({ type: "image", source: { type: "base64", media_type: p.mediaType, data: p.base64 } } as const),
  );
}

function splitSystemFromMessages(messages: LlmMessage[]): {
  system: string | undefined;
  rest: Anthropic.MessageParam[];
} {
  // System-Nachrichten sind immer Text (Bilder gehören in die User-Nachricht).
  const systemParts = messages
    .filter((m) => m.role === "system")
    .map((m) => messageText(m.content))
    .join("\n\n");
  const rest = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: toAnthropicContent(m.content) }));
  return { system: systemParts || undefined, rest };
}

async function anthropicChat(config: LlmConfig, messages: LlmMessage[]): Promise<string> {
  const { system, rest } = splitSystemFromMessages(messages);
  const response = await getAnthropicClient(config).messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 1024,
    system,
    messages: rest,
  });
  const block = response.content[0];
  return block.type === "text" ? block.text : "";
}

async function* anthropicStream(config: LlmConfig, messages: LlmMessage[]): AsyncGenerator<string> {
  const { system, rest } = splitSystemFromMessages(messages);
  const stream = getAnthropicClient(config).messages.stream({
    model: ANTHROPIC_MODEL,
    max_tokens: 1024,
    system,
    messages: rest,
  });
  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      yield event.delta.text;
    }
  }
}

// ── Ollama ───────────────────────────────────────────────────────────────────

/** Vision-fähiges Ollama-Modell für Turns MIT Bild (Env-Override, Default qwen2.5vl:7b). */
const OLLAMA_VISION_MODEL = process.env.AI_KEYHOLDER_OLLAMA_VISION_MODEL ?? "qwen2.5vl:7b";

function ollamaUrl(config: LlmConfig, path: string): string {
  const base = (config.ollamaBaseUrl ?? "http://localhost:11434").replace(/\/$/, "");
  return `${base}${path}`;
}

/** Enthält irgendeine Nachricht einen Bild-Block? */
function messagesHaveImage(messages: LlmMessage[]): boolean {
  return messages.some((m) => typeof m.content !== "string" && m.content.some((p) => p.type === "image"));
}

/**
 * Modellwahl nach Modalität: reine Text-Turns laufen auf dem konfigurierten Text-Modell
 * (schnell + gutes Deutsch, z.B. qwen3:8b), nur Turns MIT Bild auf dem Vision-Modell. So muss
 * die Keyholderin nicht dauerhaft am langsameren Vision-Modell hängen, nur weil gelegentlich
 * ein Foto kommt. Fällt config.ollamaModel weg, bleibt der bisherige Default erhalten.
 */
function ollamaModelFor(config: LlmConfig, messages: LlmMessage[]): string {
  if (messagesHaveImage(messages)) return config.ollamaVisionModel ?? OLLAMA_VISION_MODEL;
  return config.ollamaModel ?? "qwen2.5:32b";
}

/**
 * Qwen3 hat einen Reasoning-Modus, der per Default aktiv ist und <think>…</think>-Blöcke
 * ausgibt (im Chat sichtbar + langsamer). `/no_think` im System-Prompt schaltet ihn ab.
 * Nur für qwen3-Modelle; für alle anderen unverändert.
 */
function applyNoThink(model: string, messages: LlmMessage[]): LlmMessage[] {
  if (!/qwen3/i.test(model)) return messages;
  const sysIdx = messages.findIndex((m) => m.role === "system");
  if (sysIdx === -1) return [{ role: "system", content: "/no_think" }, ...messages];
  const sysText = messageText(messages[sysIdx].content);
  if (sysText.includes("/no_think")) return messages;
  const copy = messages.slice();
  copy[sysIdx] = { role: "system", content: `${sysText}\n/no_think` };
  return copy;
}

/** Entfernt einen führenden <think>…</think>-Block (Nicht-Stream-Antwort). */
function stripThinkBlock(s: string): string {
  return s.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, "");
}

/**
 * Filtert einen evtl. führenden <think>…</think>-Block aus einem Delta-Stream heraus
 * (Qwen3 kann trotz /no_think einen leeren Think-Block senden). Alles danach wird normal
 * durchgereicht. Für Modelle ohne Think-Block ein No-Op (sofortiger Passthrough).
 */
async function* stripLeadingThink(src: AsyncGenerator<string>): AsyncGenerator<string> {
  let buf = "";
  let mode: "detect" | "inThink" | "pass" = "detect";
  for await (const chunk of src) {
    if (mode === "pass") {
      yield chunk;
      continue;
    }
    buf += chunk;
    if (mode === "detect") {
      const t = buf.replace(/^\s+/, "");
      if (t === "" || "<think>".startsWith(t)) continue; // noch mehrdeutig → weiter puffern
      if (t.startsWith("<think>")) {
        mode = "inThink";
      } else {
        mode = "pass";
        yield buf;
        buf = "";
        continue;
      }
    }
    if (mode === "inThink") {
      const end = buf.indexOf("</think>");
      if (end === -1) continue; // Ende noch nicht da → weiter puffern
      const after = buf.slice(end + "</think>".length).replace(/^\s+/, "");
      mode = "pass";
      buf = "";
      if (after) yield after;
    }
  }
  if (mode !== "inThink" && buf) yield buf; // Rest (sehr kurzer Stream ohne Think-Block)
}

/** Blöcke → OpenAI-kompatibler Content (data-URI für Bilder, wie in src/lib/vision/local.ts). */
function toOpenAiMessages(messages: LlmMessage[]) {
  return messages.map((m) => ({
    role: m.role,
    content: typeof m.content === "string"
      ? m.content
      : m.content.map((p) =>
          p.type === "text"
            ? { type: "text" as const, text: p.text }
            : { type: "image_url" as const, image_url: { url: `data:${p.mediaType};base64,${p.base64}` } },
        ),
  }));
}

async function ollamaChat(config: LlmConfig, messages: LlmMessage[]): Promise<string> {
  const model = ollamaModelFor(config, messages);
  const res = await fetch(ollamaUrl(config, "/v1/chat/completions"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: toOpenAiMessages(applyNoThink(model, messages)),
      stream: false,
    }),
  });
  if (!res.ok) {
    throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return stripThinkBlock(data.choices?.[0]?.message?.content ?? "");
}

async function* ollamaStream(
  config: LlmConfig,
  messages: LlmMessage[],
): AsyncGenerator<string> {
  const model = ollamaModelFor(config, messages);
  yield* stripLeadingThink(ollamaStreamRaw(config, model, applyNoThink(model, messages)));
}

/** Roher Delta-Stream vom Ollama-OpenAI-Endpoint (ohne Think-Filter). */
async function* ollamaStreamRaw(
  config: LlmConfig,
  model: string,
  messages: LlmMessage[],
): AsyncGenerator<string> {
  const res = await fetch(ollamaUrl(config, "/v1/chat/completions"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: toOpenAiMessages(messages),
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Ollama stream error ${res.status}: ${await res.text()}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.replace(/^data: /, "").trim();
      if (!trimmed || trimmed === "[DONE]") continue;
      try {
        const parsed = JSON.parse(trimmed);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // malformed chunk — skip
      }
    }
  }
}
