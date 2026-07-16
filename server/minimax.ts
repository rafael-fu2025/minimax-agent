/**
 * MiniMax API client. Streams chat completions and lists available
 * models. Compatible with OpenAI's chat-completions + models endpoints.
 *
 * The actual call path runs through `KeyRotator` (see `./keys/rotator.ts`):
 * the rotator picks a key (or the env-var bootstrap), rotates on 429/5xx,
 * and updates the per-key counters.
 */

import type { Readable } from "node:stream";

/* -------------------------------------------------------------------------- */
/* Multimodal content                                                          */
/* -------------------------------------------------------------------------- */

/**
 * OpenAI-compatible content parts. MiniMax M3 supports text, image_url, and
 * video_url in a single user message. Images must be JPEG/PNG/GIF/WEBP and
 * ≤10 MB; videos must be MP4/AVI/MOV/MKV, ≤50 MB via base64, or referenced
 * by `mm_file://{file_id}` for up to 512 MB uploads via the Files API.
 */
export type ContentPart =
  | { type: "text"; text: string }
  | {
      type: "image_url";
      image_url: { url: string; detail?: "low" | "default" | "high" };
    }
  | {
      type: "video_url";
      video_url: { url: string; fps?: number };
    };

/**
 * The `content` field on a chat message is either a plain string (text-only)
 * or an array of `ContentPart` (interleaved text + image + video). The
 * OpenAI-compatible Chat Completions API accepts both shapes.
 */
export type MessageContent = string | ContentPart[];

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: MessageContent }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolSchema {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

/** OpenAI function-calling wire format (what we send to the model). */
export interface OpenAIToolWire {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

export interface StreamChunk {
  /** Incremental assistant text, if any. */
  delta?: string;
  /**
   * Incremental chain-of-thought ("reasoning") text from the model.
   * MiniMax M3 streams reasoning on a separate `reasoning_content` field
   * rather than wrapping it in  markers. We surface it here so the
   * client can render the Thinking block correctly.
   */
  reasoning?: string;
  /** A complete tool-call delta, when one is finalized. */
  toolCall?: ToolCall;
  /** Token usage info from a final `usage` chunk. */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** Final usage info. */
  finishReason?: string;
}

export interface StreamOptions {
  messages: ChatMessage[];
  /** OpenAI function-calling wire format. */
  tools?: OpenAIToolWire[];
  model?: string;
  signal?: AbortSignal;
}

export interface ModelInfo {
  id: string;
  ownedBy?: string;
  created?: number;
}

const DEFAULT_BASE_URL = "https://api.minimax.io/v1";
const DEFAULT_MODEL = "MiniMax-M3";

/**
 * Strip stray  and  markers that the model may emit
 * directly in delta.content. We strip closing tags in particular because
 * the chat template can append one as soon as the reasoning channel ends,
 * which used to leak into the user-visible message.
 */
export function stripStrayThinkTags(s: string): string {
  return s.replace(/<\/?think>/g, "");
}

export function getConfig() {
  return {
    apiKey: process.env.MINIMAX_API_KEY ?? "",
    baseUrl: (process.env.MINIMAX_BASE_URL ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      ""
    ),
    defaultModel: process.env.MINIMAX_MODEL ?? DEFAULT_MODEL,
  };
}


/**
 * Return true once `args` holds a syntactically complete JSON value (object or
 * array). Streams from MiniMax can break a tool call's `arguments` across many
 * chunks; the old heuristic `startsWith("{") && endsWith("}")` flushed at the
 * first inner `}`, corrupting nested payloads like `{"cfg":{"k":"v"}}`. This
 * walks the string with a balanced-brace counter that skips over string
 * literals (including `"` and `'` escapes, and braces inside `"a{b}c"`).
 */
export function isCompleteJson(args: string): boolean {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        // Make sure the closing brace ends the value (no trailing junk).
        return i === args.length - 1;
      }
    }
  }
  return false;
}
/* Lazy rotator import to avoid a circular dep at module load. */
async function rotator() {
  const { getRotator } = await import("./keys/rotator.js");
  return getRotator(getConfig().baseUrl);
}

export async function* streamChat({
  messages,
  tools,
  model,
  signal,
}: StreamOptions): AsyncGenerator<StreamChunk> {
  // We rely on the key rotator (DB-stored keys + optional env-var bootstrap).
  // The rotator throws its own "no keys configured" error when the pool is
  // empty, so we no longer bail out here on a missing env-var key.
  const cfg = getConfig();

  const body = {
    model: model ?? cfg.defaultModel,
    messages,
    tools,
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0.7,
  } as Record<string, unknown>;

  // The rotator picks a key (or the env-var bootstrap), rotates on
  // 429/5xx, and updates the per-key counters. The request body itself
  // is identical across keys.
  const rot = await rotator();
  const res = await rot.call(async (secret: string) =>
    fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify(body),
      signal,
    })
  );

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `MiniMax API error ${res.status}: ${text || res.statusText || "unknown"}`
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Track tool calls being assembled across chunks (id, name, arg fragments).
  const toolAcc = new Map<
    number,
    { id: string; name: string; args: string }
  >();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE: events are separated by a blank line.
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        const lines = part.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") return;
          if (!payload) continue;

          let json: any;
          try {
            json = JSON.parse(payload);
          } catch {
            continue;
          }

          // Capture usage chunks FIRST — OpenAI/MiniMax send a final
          // chunk with `choices: []` and `usage: {...}`. We must process it
          // before short-circuiting on missing choices.
          const usageRaw = json?.usage;
          if (usageRaw && typeof usageRaw === "object") {
            const promptTokens = Number(usageRaw.prompt_tokens ?? 0);
            const completionTokens = Number(usageRaw.completion_tokens ?? 0);
            const totalTokens = Number(
              usageRaw.total_tokens ?? promptTokens + completionTokens
            );
            if (totalTokens > 0) {
              yield { usage: { promptTokens, completionTokens, totalTokens } };
            }
          }

          const choice = json?.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta ?? {};

          // Forward reasoning content separately so the client can render
          // it inside the Thinking block instead of leaking the tags as
          // visible text. MiniMax M3 streams reasoning on a separate
          // `reasoning_content` field (not wrapped in  markers).
          if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
            yield { reasoning: delta.reasoning_content };
          }

          if (typeof delta.content === "string" && delta.content.length > 0) {
            // The chat template occasionally emits stray 
            // tags directly into the visible content stream when the
            // reasoning channel has already closed. Strip them so the client
            // never sees raw markup.
            const cleaned = stripStrayThinkTags(delta.content);
            if (cleaned.length > 0) {
              yield { delta: cleaned };
            }
          }

          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx: number = tc.index ?? 0;
              const acc =
                toolAcc.get(idx) ?? { id: "", name: "", args: "" };
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name += tc.function.name;
              if (tc.function?.arguments)
                acc.args += tc.function.arguments;
              toolAcc.set(idx, acc);

              // Some providers send a complete tool_call in the final chunk
              // without a finishReason at the choice level. Flush when the
              // accumulated arguments form a balanced JSON value (object or
              // array), not just when the last char is a closing brace.
              const trimmedArgs = acc.args.trim();
              if (
                isCompleteJson(trimmedArgs) &&
                acc.id &&
                acc.name
              ) {
                toolAcc.delete(idx);
                yield {
                  toolCall: {
                    id: acc.id,
                    type: "function",
                    function: { name: acc.name, arguments: acc.args },
                  },
                };
              }
            }
          }

          if (choice.finish_reason) {
            // Flush any remaining tool calls.
            for (const [, acc] of toolAcc) {
              if (acc.id && acc.name) {
                yield {
                  toolCall: {
                    id: acc.id,
                    type: "function",
                    function: { name: acc.name, arguments: acc.args },
                  },
                };
              }
            }
            toolAcc.clear();
            yield { finishReason: choice.finish_reason };
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * GET /v1/models — OpenAI-compatible list endpoint.
 * MiniMax returns `{ object: "list", data: [{ id, object, created, owned_by }] }`.
 * We map it into a compact ModelInfo[] shape.
 */
export async function listModels(): Promise<ModelInfo[]> {
  const cfg = getConfig();
  // Same fix: trust the rotator; the env-var key is optional.
  const rot = await rotator();
  const res = await rot.call(async (secret: string) =>
    fetch(`${cfg.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${secret}` },
    })
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `MiniMax list-models error ${res.status}: ${text || res.statusText || "unknown"}`
    );
  }
  const json = (await res.json()) as { data?: Array<Record<string, unknown>> };
  if (!Array.isArray(json.data)) return [];
  return json.data
    .map((m): ModelInfo | null => {
      if (typeof m.id !== "string") return null;
      return {
        id: m.id,
        ownedBy: typeof m.owned_by === "string" ? m.owned_by : undefined,
        created: typeof m.created === "number" ? m.created : undefined,
      };
    })
    .filter((m): m is ModelInfo => m !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
}



