/**
 * Agent loop: drives a single user turn through potentially multiple
 * model -> tool -> model -> ... rounds, streaming incremental updates
 * back to the client as Server-Sent Events.
 *
 * Wire format (newline-delimited JSON over an SSE-style `data:` channel):
 *   data: {"type":"text","delta":"..."}\n\n
 *   data: {"type":"tool_call","id":"...","name":"...","arguments":"..."}\n\n
 *   data: {"type":"tool_result","id":"...","name":"...","output":"..."}\n\n
 *   data: {"type":"done","finishReason":"stop"}\n\n
 *   data: {"type":"error","message":"..."}\n\n
 *
 * Persistence is decoupled via an optional `PersistenceHooks` bundle passed
 * in by `server/index.ts`. This file does not import anything from
 * `server/db/*` so it stays database-agnostic.
 */

import type { Response } from "express";
import { randomUUID } from "node:crypto";
import { runTool, tools as liveTools, toolSchemas } from "./tools.js";
import { awaitApproval } from "./approvals.js";
import {
  parseApprovalMode,
  formatToolPreview,
  requiresApproval,
  type ToolApprovalMode,
} from "./tools/approval.js";
import {
  streamChat,
  type ChatMessage,
  type ToolCall,
} from "./minimax.js";
import type { PersistenceHooks, UserMessageContent } from "./persistence.js";
import { getModelLimits } from "./models.js";

const SYSTEM_PROMPT_LINES = [
  "You are Astryx, a helpful, concise assistant running inside a chat UI built on Meta's Astryx design system.",
  "You can call tools when they help. When you do, briefly tell the user what you're doing.",
  "Format replies in Markdown. Use short paragraphs and bullets where appropriate. Keep answers tight unless the user asks for depth.",
];

export { getModelLimits, MODEL_LIMITS } from "./models.js";

export interface AgentRequest {
  messages: Array<{
    role: "user" | "assistant" | "system";
    /**
     * The `user` role may carry multimodal content (text + image + video
     * parts). System and assistant messages stay as plain text. The shape
     * mirrors `ChatMessage["content"]` from `./minimax.js` — kept as
     * `unknown` here to avoid a circular import and let the model client
     * validate before sending.
     */
    content: string | unknown[];
  }>;
  model?: string;
  /**
   * Optional server-side conversation id. When present and the persistence
   * hooks are wired, the user message, every assistant turn, and every tool
   * result are persisted best-effort to that conversation.
   */
  conversationId?: string;
  /** Optional persistence callbacks. Omit for stateless runs. */
  persistence?: PersistenceHooks;
  /**
   * Optional pre-formatted memory block. When non-empty, prepended to the
   * system prompt so the model sees relevant prior context. Resolved by
   * `server/index.ts`; this loop treats it as opaque text.
   */
  recallBlock?: string;
  /**
   * Optional cap on the number of model -> tool -> model rounds inside a
   * single user turn. Defaults to `DEFAULT_MAX_TURNS`. The loop still has
   * a hard ceiling (`ABSOLUTE_MAX_TURNS`) so a runaway caller can never crash
   * the server; values above the ceiling are clamped down.
   */
  maxTurns?: number;
  /**
   * Optional system-reminder message prepended to the very top of the chat
   * history (before the personality prompt). Typical use: the server injects
   * today's date here so time-sensitive web searches stay anchored to the
   * present rather than the model's training-data cutoff.
   */
  systemReminder?: string;
  /**
   * Per-request permission mode sent by the client. Decides which tools
   * require explicit user approval before they run. Defaults to `"safe"`.
   */
  permissionMode?: ToolApprovalMode;
}

export async function runAgent(
  req: AgentRequest,
  res: Response,
  signal: AbortSignal,
): Promise<void> {
  // SSE-friendly headers.
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (event: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const persistence = req.persistence;
  const conversationId = req.conversationId;
  const permissionMode = parseApprovalMode(req.permissionMode);

  // Compose the system prompt: optional server-injected reminder (e.g.
  // today's date) at the top, then recall block + persona lines. The
  // reminder comes first so the model sees time context before any user turn.
  const reminderSection = req.systemReminder?.trim() ?? null;
  const systemContent = [
    reminderSection,
    req.recallBlock?.trim() ? req.recallBlock : null,
    ...SYSTEM_PROMPT_LINES,
  ]
    .filter(Boolean)
    .join("\n\n");

  const history: ChatMessage[] = [
    { role: "system", content: systemContent },
    ...req.messages
      .filter((m) => m.role !== "system")
      .map<ChatMessage>((m) => ({
        // The wire type carries `unknown[]` for multimodal content; the model
        // client validates before sending, so the cast is safe at the agent
        // boundary. We cast the whole entry to `ChatMessage` because
        // TypeScript cannot narrow the role-conditional content type from
        // a runtime-typed request shape.
        ...(m as unknown as ChatMessage),
      })),
  ];

  // Persist the freshly typed user message at the start of the turn.
  // Best-effort: failures are logged inside `safePersistence` and never
  // surface here.
  if (persistence && conversationId) {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    if (lastUser) {
      // Fire-and-forget; the SSE stream continues regardless.
      void persistence.onUserMessage({
        conversationId,
        // Same wire-type cast as above: the client trusts us with the
        // unknown[] shape and the persistence layer validates per-part.
        content: lastUser.content as UserMessageContent,
      });
    }
  }

  // Aggregate token usage across the whole agent loop. Each turn sends
  // a usage chunk at the end of its stream; we sum them so the client
  // sees the *total* tokens spent on this user turn.
  const usage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };

  // Agentic loop: keep going until the model emits a final assistant message
  // without tool_calls (or we hit the safety cap). We default to a generous
  // budget so deep-analysis tasks that legitimately need 20+ tool calls can
  // complete their final summary turn, while the absolute ceiling prevents
  // runaway loops.
  const DEFAULT_MAX_TURNS = 25;
  const ABSOLUTE_MAX_TURNS = 50;
  const requestedTurns = req.maxTurns;
  const maxTurns = Math.min(
    ABSOLUTE_MAX_TURNS,
    typeof requestedTurns === "number" && requestedTurns > 0
      ? Math.floor(requestedTurns)
      : DEFAULT_MAX_TURNS,
  );
  let lastFinishReason = "";
  let lastAssistantText = "";
  let lastPendingToolCalls: ToolCall[] = [];
  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      let pendingToolCalls: ToolCall[] = [];
      let assistantText = "";
      let finishReason = "";

      // Snapshot usage so we can compute per-turn usage for persistence.
      const prevUsage = { ...usage };

      for await (const chunk of streamChat({
        messages: history,
        tools: toolSchemas,
        model: req.model,
        signal,
      })) {
        if (signal.aborted) break;
        if (chunk.delta) {
          assistantText += chunk.delta;
          send({ type: "text", delta: chunk.delta });
        }
        if (chunk.reasoning) {
          // MiniMax M3 streams chain-of-thought on a separate field. The
          // client wires this into the Thinking block; without it the
          // reasoning would be lost (and stray  tags would leak
          // into the visible message).
          send({ type: "reasoning", delta: chunk.reasoning });
        }
        if (chunk.toolCall) {
          pendingToolCalls.push(chunk.toolCall);
          send({
            type: "tool_call",
            id: chunk.toolCall.id,
            name: chunk.toolCall.function.name,
            arguments: chunk.toolCall.function.arguments,
          });
        }
        if (chunk.usage) {
          usage.promptTokens += chunk.usage.promptTokens;
          usage.completionTokens += chunk.usage.completionTokens;
          usage.totalTokens += chunk.usage.totalTokens;
          // Forward a running total so the client can render a live
          // progress bar as each tool result round completes.
          send({ type: "usage", ...usage });
        }
        if (chunk.finishReason) {
          finishReason = chunk.finishReason;
        }
      }

      const turnUsage = {
        promptTokens: usage.promptTokens - prevUsage.promptTokens,
        completionTokens: usage.completionTokens - prevUsage.completionTokens,
        totalTokens: usage.totalTokens - prevUsage.totalTokens,
      };

      // If the model didn't ask for any tools, we're done with this turn.
      if (pendingToolCalls.length === 0) {
        // Persist the final assistant message so future turns have context.
        if (assistantText) {
          history.push({ role: "assistant", content: assistantText });
        }
        // Persist to DB only if not aborted and we have text. The
        // `pendingToolCalls.length > 0` clause was dead — we already early-
        // returned from the function above this block in that case — and
        // made the predicate harder to read.
        if (
          !signal.aborted &&
          persistence &&
          conversationId &&
          assistantText
        ) {
          void persistence.onAssistantTurn({
            conversationId,
            content: assistantText,
            toolCalls: pendingToolCalls,
            usage: turnUsage,
          });
        }
        // Final usage event (in case the API didn't emit a per-turn one).
        if (usage.totalTokens > 0) {
          send({ type: "usage", ...usage });
        }
        // Surface an explicit "aborted" finish reason when the user
        // stops the run mid-stream, so the client UI can render the correct
        // affordance instead of treating the truncated reply as a clean stop.
        const aborted = signal.aborted;
        send({
          type: "done",
          finishReason: aborted
            ? "aborted"
            : finishReason || "stop",
        });
        return;
      }

      // Snapshot the post-stream state so the wrap-up block can finalize
      // even after we exit the loop without sending `done` (e.g. via the safety
      // cap). This avoids dropping the trailing assistant text and gives the
      // client a meaningful finish reason.
      lastFinishReason = finishReason;
      lastAssistantText = assistantText;
      lastPendingToolCalls = pendingToolCalls;

      // Record the assistant turn (with tool_calls) before running tools.
      history.push({
        role: "assistant",
        content: assistantText || null,
        tool_calls: pendingToolCalls,
      });

      // Persist this intermediate assistant turn if not aborted.
      if (
        !signal.aborted &&
        persistence &&
        conversationId &&
        (assistantText || pendingToolCalls.length > 0)
      ) {
        void persistence.onAssistantTurn({
          conversationId,
          content: assistantText || null,
          toolCalls: pendingToolCalls,
          usage: turnUsage,
        });
      }

      // Execute each tool sequentially and feed results back.
      for (const tc of pendingToolCalls) {
        if (signal.aborted) break;
        let output: string;
        // The most recent user message's `content` — used by tool wrappers
        // that need to materialize inline image_url / video_url parts into
        // a sandbox path the upstream MCP can read (see `runTool` in
        // `./tools.ts` for the `mcp_*_understand_image` rewrite).
        const lastUserContent = (() => {
          for (let i = history.length - 1; i >= 0; i--) {
            const m = history[i];
            if (m.role === "user") return m.content;
          }
          return undefined;
        })();
        if (requiresApproval(tc.function.name, permissionMode)) {
          const approvalId = randomUUID();
          send({
            type: "approval_required",
            id: approvalId,
            tool: tc.function.name,
            arguments: tc.function.arguments,
            preview: formatToolPreview(
            tc.function.name,
            tc.function.arguments,
            liveTools,
          ),
          });
          const decision = await awaitApproval(
            approvalId,
            permissionMode,
            signal,
          );
          if (signal.aborted || decision === "deny") {
            output = signal.aborted
              ? "Error: chat was stopped before this tool ran."
              : `Error: denied by user (mode=${permissionMode}). The tool was not executed.`;
          } else {
            output = await runTool(tc.function.name, tc.function.arguments, {
              permissionMode,
              lastUserContent,
            });
          }
        } else {
          output = await runTool(tc.function.name, tc.function.arguments, {
            permissionMode,
            lastUserContent,
          });
        }
        send({
          type: "tool_result",
          id: tc.id,
          name: tc.function.name,
          output,
        });
        history.push({
          role: "tool",
          tool_call_id: tc.id,
          content: output,
        });
        if (persistence && conversationId && !signal.aborted) {
          void persistence.onToolResult({
            conversationId,
            toolCallId: tc.id,
            toolName: tc.function.name,
            output,
          });
        }
      }
      if (signal.aborted) break;
      // Loop again so the model can react to the tool outputs.
    }

    // Loop exited without the natural "no pending tool calls -> send done" branch.
    // Persist any trailing assistant text so it is not lost, then finalize
    // the stream with a clear finish reason. The client surfaces this as a
    // "response truncated" hint instead of an orphan streaming bubble.
    if (lastAssistantText && !signal.aborted) {
      history.push({ role: "assistant", content: lastAssistantText });
    }
    if (lastAssistantText && !signal.aborted && persistence && conversationId) {
      void persistence.onAssistantTurn({
        conversationId,
        content: lastAssistantText,
        toolCalls: lastPendingToolCalls,
        usage: {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
        },
      });
    }
    if (usage.totalTokens > 0 && !signal.aborted) {
      send({ type: "usage", ...usage });
    }
    if (signal.aborted) {
      send({ type: "done", finishReason: "aborted" });
    } else if (lastFinishReason && lastFinishReason !== "tool_calls") {
      send({ type: "done", finishReason: lastFinishReason });
    } else {
      send({ type: "done", finishReason: "truncated" });
    }
  } catch (err) {
    const message = (err as Error).message ?? "Unknown agent error";
    send({ type: "error", message });
    if (persistence && conversationId) {
      void persistence.onError({ conversationId, message });
    }
  } finally {
    res.end();
  }
}



