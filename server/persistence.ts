/**
 * Persistence contract for the agent loop.
 *
 * Defined here (not in `server/db/`) so `server/agent.ts` can stay
 * database-agnostic — it imports `PersistenceHooks` from this file, and the
 * actual implementations live in `server/index.ts`, which knows about
 * `server/db/*`.
 *
 * Every hook may throw. Wrap implementations with `safePersistence` before
 * handing them to `runAgent` so failed writes never interrupt the SSE stream.
 */

import type { ContentPart, ToolCall } from "./minimax.js";

/** What the agent hands to the persistence layer for a user message.
 *  Plain text becomes `string`; multimodal messages become
 *  `ContentPart[]` (text + image_url + video_url). */
export type UserMessageContent = string | ContentPart[];

export interface PersistenceHooks {
  /** Persist the freshly-typed user message at the start of a turn. */
  onUserMessage(input: {
    conversationId: string;
    content: UserMessageContent;
  }): Promise<void>;

  /** Persist a completed assistant turn — text, tool calls, token usage. */
  onAssistantTurn(input: {
    conversationId: string;
    content: string | null;
    toolCalls: ToolCall[];
    usage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
  }): Promise<void>;

  /** Persist a tool's output. */
  onToolResult(input: {
    conversationId: string;
    toolCallId: string;
    toolName: string;
    output: string;
  }): Promise<void>;

  /** Mark the conversation's last turn as errored. */
  onError(input: { conversationId: string; message: string }): Promise<void>;
}

/**
 * Drop-in no-op hooks. Useful for tests and for stateless runs where no
 * `conversationId` was supplied.
 */
export const NOOP_PERSISTENCE: PersistenceHooks = {
  onUserMessage: async () => {},
  onAssistantTurn: async () => {},
  onToolResult: async () => {},
  onError: async () => {},
};

/**
 * Wraps every hook so failures are caught and logged as `[persistence]`
 * warnings instead of propagating up the SSE stream. The stream's contract
 * is "errors during persistence are logged but do not break the chat".
 */
export function safePersistence(p: PersistenceHooks): PersistenceHooks {
  const wrap =
    <K extends keyof PersistenceHooks>(name: K): PersistenceHooks[K] =>
    (async (...args: Parameters<PersistenceHooks[K]>) => {
      try {
        await (p[name] as (...a: unknown[]) => Promise<unknown>)(
          ...args,
        );
      } catch (err) {
        console.warn(
          `[persistence] ${name} failed:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }) as PersistenceHooks[K];

  return {
    onUserMessage: wrap("onUserMessage"),
    onAssistantTurn: wrap("onAssistantTurn"),
    onToolResult: wrap("onToolResult"),
    onError: wrap("onError"),
  };
}

/* -------------------------------------------------------------------------- */
/* Memory hooks                                                               */
/* -------------------------------------------------------------------------- */

export interface MemoryHooks {
  /** Index one persisted message into the vector store. */
  onMessageIndexed(input: {
    conversationId: string;
    messageId: bigint;
    role: "user" | "assistant";
    content: string;
  }): Promise<void>;
}

export const NOOP_MEMORY: MemoryHooks = {
  onMessageIndexed: async () => {},
};

export function safeMemory(m: MemoryHooks): MemoryHooks {
  return {
    onMessageIndexed: async (input) => {
      try {
        await m.onMessageIndexed(input);
      } catch (err) {
        console.warn(
          "[memory] onMessageIndexed failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    },
  };
}
