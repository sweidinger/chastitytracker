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

function ollamaUrl(config: LlmConfig, path: string): string {
  const base = (config.ollamaBaseUrl ?? "http://localhost:11434").replace(/\/$/, "");
  return `${base}${path}`;
}

function ollamaModel(config: LlmConfig): string {
  return config.ollamaModel ?? "qwen2.5:32b";
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
  const res = await fetch(ollamaUrl(config, "/v1/chat/completions"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ollamaModel(config),
      messages: toOpenAiMessages(messages),
      stream: false,
    }),
  });
  if (!res.ok) {
    throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

async function* ollamaStream(
  config: LlmConfig,
  messages: LlmMessage[],
): AsyncGenerator<string> {
  const res = await fetch(ollamaUrl(config, "/v1/chat/completions"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ollamaModel(config),
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
