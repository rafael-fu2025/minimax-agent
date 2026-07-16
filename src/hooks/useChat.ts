/**
 * `useChat` — streaming agent-loop state machine.
 *
 * Owns the in-flight chat state: whether we're streaming, the live token
 * usage while a stream is in progress, pending approval prompts, the
 * composer remount key (forces the composer to reset), the workspace tree
 * refresh version (debounced), and the abort controller.
 *
 * The active conversation is owned by `useConversations`. This hook reads
 * `activeMessages` and writes back through `setActiveMessages`, so the
 * sidebar ordering and persistence stay in sync without the hook knowing
 * about localStorage.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { streamAgent, uploadFile, sendApproval } from "../api";
import { newId } from "../conversations";
import type {
  AgentEvent,
  AttachmentMeta,
  ContentPart,
  PermissionMode,
  UiMessage,
  UiToolCall,
} from "../types";
import type { PendingApproval } from "../components/ApprovalDialog";

/* -------------------------------------------------------------------------- */
/* Thinking-block parser (small enough to live here; main.tsx no longer needs it) */
/* -------------------------------------------------------------------------- */

interface ThinkingState {
  content: string;
  thinking: string;
  inThink: boolean;
  buffer: string;
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

function stripStrayThinkTags(s: string): string {
  return s.replaceAll("<think>", "").replaceAll("</think>", "");
}

function feedThinking(
  state: ThinkingState,
  delta: string,
):
  | { visible: string; thinking: string }
  | null {
  if (!delta) return null;
  let text = state.buffer + delta;
  let visible = "";
  let thinking = "";

  while (text.length > 0) {
    if (state.inThink) {
      const closeIdx = text.indexOf(THINK_CLOSE);
      if (closeIdx === -1) {
        const keep = Math.min(text.length, THINK_CLOSE.length - 1);
        thinking += text.slice(0, text.length - keep);
        state.buffer = text.slice(text.length - keep);
        text = "";
        break;
      }
      thinking += text.slice(0, closeIdx);
      text = text.slice(closeIdx + THINK_CLOSE.length);
      state.inThink = false;
    } else {
      // Tolerate a stray leading  that the chat template
      // emits after the reasoning channel ends (e.g. the first visible
      // token after reasoning_content is "). The model never opened
      // a think block from this client perspective, so we just discard
      // the marker instead of leaking it into the visible text.
      const strayClose = text.indexOf(THINK_CLOSE);
      if (strayClose === 0) {
        text = text.slice(THINK_CLOSE.length);
        continue;
      }

      const openIdx = text.indexOf(THINK_OPEN);
      if (openIdx === -1) {
        const keep = Math.min(text.length, THINK_OPEN.length - 1);
        visible += text.slice(0, text.length - keep);
        state.buffer = text.slice(text.length - keep);
        text = "";
        break;
      }
      visible += text.slice(0, openIdx);
      text = text.slice(openIdx + THINK_OPEN.length);
      state.inThink = true;
    }
  }

  if (!visible && !thinking) return null;
  return { visible, thinking };
}

function flushThinking(
  state: ThinkingState,
): { visible: string; thinking: string } | null {
  const tail = state.buffer;
  state.buffer = "";
  if (!tail) return null;
  if (state.inThink) return { visible: "", thinking: tail };
  return { visible: tail, thinking: "" };
}

/* -------------------------------------------------------------------------- */
/* Streaming event dispatcher                                                  */
/* -------------------------------------------------------------------------- */

function handleAgentEvent(
  event: AgentEvent,
  update: (
    patchOrFn:
      | Partial<UiMessage>
      | ((prev: UiMessage) => Partial<UiMessage>),
  ) => void,
  toolTimers: Map<string, number>,
  thinkState: ThinkingState,
  onWriteFileComplete: () => void,
): void {
  switch (event.type) {
    case "text": {
      const split = feedThinking(thinkState, event.delta);
      if (!split) return;
      const visible = stripStrayThinkTags(split.visible);
      const thinking = stripStrayThinkTags(split.thinking);
      update((prev: UiMessage) => ({
        content: (prev.content ?? "") + visible,
        thinking: (prev.thinking ?? "") + thinking,
        status: "streaming",
      }));
      return;
    }

    case "reasoning": {
      // MiniMax M3 streams reasoning on a dedicated event so we never
      // depend on the model wrapping it in  markers. Append directly
      // to the Thinking block.
      update((prev: UiMessage) => ({
        thinking: (prev.thinking ?? "") + (event.delta ?? ""),
        status: "streaming",
      }));
      return;
    }

    case "tool_call": {
      const tc: UiToolCall = {
        id: event.id,
        name: event.name,
        arguments: event.arguments,
        status: "running",
      };
      toolTimers.set(event.id, performance.now());
      update((prev: UiMessage) => ({
        toolCalls: [...(prev.toolCalls ?? []), tc],
      }));
      return;
    }

    case "tool_result": {
      const startedAt = toolTimers.get(event.id);
      const durationMs =
        startedAt !== undefined
          ? Math.max(1, Math.round(performance.now() - startedAt))
          : undefined;
      toolTimers.delete(event.id);
      // Refresh the workspace tree when the agent finishes writing a file.
      // The callback is debounced at the call-site so 5 rapid writes
      // collapse to one refetch.
      if (event.name === "write_file") {
        onWriteFileComplete();
      }
      update((prev: UiMessage) => ({
        toolCalls: (prev.toolCalls ?? []).map((tc: UiToolCall) =>
          tc.id === event.id
            ? {
                ...tc,
                status: event.output.startsWith("Error") ? "error" : "complete",
                output: event.output,
                durationMs,
              }
            : tc,
        ),
      }));
      return;
    }

    case "done":
    case "error":
      return;
  }
}

/* -------------------------------------------------------------------------- */
/* Hook                                                                       */
/* -------------------------------------------------------------------------- */

export interface UseChatOpts {
  /** Current messages of the active conversation. */
  activeMessages: UiMessage[];
  /** Imperative setter used to push updates back to the active conversation. */
  setActiveMessages: (updater: (prev: UiMessage[]) => UiMessage[]) => void;
  /** The user's selected model. */
  selectedModel: string;
  /** Permission mode forwarded to the backend on every request. */
  permissionMode: PermissionMode;
  /** Stable attachments lookup that the composer keeps in sync. */
  attachmentsRef: React.MutableRefObject<
    Map<string, AttachmentMeta & { file: File }>
  >;
  /**
   * Stable callback triggered after every successful `write_file` tool result.
   * Used by the parent to debounce a workspace-tree refresh.
   */
  onWriteFileComplete?: () => void;
}

export interface UseChatReturn {
  isStreaming: boolean;
  liveUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null;
  pendingApproval: PendingApproval | null;
  /** Bump on every send so the composer remounts and clears its draft. */
  composerKey: number;
  /** Bumped (debounced) on every `write_file` tool result. */
  treeVersion: number;
  send: (text: string, attachmentParts: ContentPart[]) => Promise<void>;
  stop: () => void;
  decideApproval: (decision: "allow" | "deny") => Promise<void>;
}

export function useChat(opts: UseChatOpts): UseChatReturn {
  const {
    activeMessages,
    setActiveMessages,
    selectedModel,
    permissionMode,
    attachmentsRef,
    onWriteFileComplete,
  } = opts;

  const [isStreaming, setIsStreaming] = useState(false);
  const [liveUsage, setLiveUsage] = useState<{
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null>(null);
  const [pendingApproval, setPendingApproval] =
    useState<PendingApproval | null>(null);
  const [composerKey, setComposerKey] = useState(0);
  const [treeVersion, setTreeVersion] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const treeRefreshTimer = useRef<number | null>(null);
  // Cancel any in-flight stream AND any pending debounced workspace-tree
  // refresh when the active conversation changes or the component unmounts.
  // Without the timer cleanup, a debounced setTimeout that fires after
  // unmount would call setTreeVersion on an unmounted component (the
  // standard React warning). Both refs are module-scoped to this hook
  // instance, so unmount clears both.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (treeRefreshTimer.current !== null) {
        clearTimeout(treeRefreshTimer.current);
        treeRefreshTimer.current = null;
      }
    };
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setPendingApproval(null);
  }, []);

  const send = useCallback(
    async (text: string, attachmentParts: ContentPart[] = []) => {
      const trimmed = text.trim();
      if (!trimmed && attachmentParts.length === 0) return;

      const resolvedParts: ContentPart[] = [];
      for (const part of attachmentParts) {
        if (
          part.type === "video_url" &&
          part.video_url.url.startsWith("__upload:")
        ) {
          const id = part.video_url.url.slice("__upload:".length);
          const meta = attachmentsRef.current.get(id);
          if (!meta || !meta.file) continue;
          try {
            const result = await uploadFile({
              file: meta.file,
              filename: meta.file.name,
              mime: meta.file.type || "application/octet-stream",
              purpose: "video_understanding",
            });
            if (!result.ok || !result.contentPart) {
              throw new Error(result.error ?? "upload failed");
            }
            resolvedParts.push(result.contentPart);
          } catch (err) {
            const userMsgErr: UiMessage = {
              id: newId(),
              role: "user",
              content: trimmed,
              status: "done",
            };
            const assistantErr: UiMessage = {
              id: newId(),
              role: "assistant",
              content: `⚠️ Upload failed: ${(err as Error).message}`,
              thinking: "",
              status: "error",
              toolCalls: [],
            };
            setActiveMessages((prev) => [...prev, userMsgErr, assistantErr]);
            return;
          }
        } else {
          resolvedParts.push(part);
        }
      }

      const userMsg: UiMessage = {
        id: newId(),
        role: "user",
        content: trimmed,
        status: "done",
        attachments: resolvedParts.length > 0 ? resolvedParts : undefined,
      };
      const assistantMsg: UiMessage = {
        id: newId(),
        role: "assistant",
        content: "",
        thinking: "",
        status: "streaming",
        toolCalls: [],
      };

      setActiveMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      const history = [...activeMessages, userMsg];
      const thinkState: ThinkingState = {
        content: "",
        thinking: "",
        inThink: false,
        buffer: "",
      };

      const updateAssistant = (
        patchOrFn:
          | Partial<UiMessage>
          | ((prev: UiMessage) => Partial<UiMessage>),
      ) => {
        setActiveMessages((prev) =>
          prev.map((m) => {
            if (m.id !== assistantMsg.id) return m;
            const patch =
              typeof patchOrFn === "function"
                ? patchOrFn(m as UiMessage)
                : patchOrFn;
            return { ...m, ...patch };
          }),
        );
      };

      const toolTimers = new Map<string, number>();
      setLiveUsage(null);

      try {
        for await (const event of streamAgent(history, controller.signal, {
          model: selectedModel,
          permissionMode,
        })) {
          if (controller.signal.aborted) break;
          if (event.type === "error") {
            updateAssistant((prev: UiMessage) => ({
              status: "error",
              content: prev.content
                ? `${prev.content}\n\n⚠️ ${event.message}`
                : `⚠️ ${event.message}`,
            }));
            break;
          }
          if (event.type === "approval_required") {
            setPendingApproval({
              id: event.id,
              tool: event.tool,
              arguments: event.arguments,
              preview: event.preview,
            });
          }
          if (event.type === "done") {
            const tail = flushThinking(thinkState);
            if (tail) {
              updateAssistant((prev: UiMessage) => ({
                content:
                  (prev.content ?? "") + stripStrayThinkTags(tail.visible),
                thinking:
                  (prev.thinking ?? "") + stripStrayThinkTags(tail.thinking),
              }));
            }
          }
          if (event.type === "usage") {
            setLiveUsage({
              promptTokens: event.promptTokens,
              completionTokens: event.completionTokens,
              totalTokens: event.totalTokens,
            });
            updateAssistant({
              usage: {
                promptTokens: event.promptTokens,
                completionTokens: event.completionTokens,
                totalTokens: event.totalTokens,
              },
            });
          }
          handleAgentEvent(
            event,
            updateAssistant,
            toolTimers,
            thinkState,
            () => {
              if (treeRefreshTimer.current) {
                clearTimeout(treeRefreshTimer.current);
              }
              treeRefreshTimer.current = window.setTimeout(() => {
                setTreeVersion((v) => v + 1);
                treeRefreshTimer.current = null;
                onWriteFileComplete?.();
              }, 250);
            },
          );
        }
        const tail = flushThinking(thinkState);
        if (tail) {
          updateAssistant((prev: UiMessage) => ({
            content: (prev.content ?? "") + tail.visible,
            thinking: (prev.thinking ?? "") + tail.thinking,
          }));
        }
        updateAssistant((prev: UiMessage) =>
          prev.status === "streaming" ? { status: "done" } : {},
        );
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unknown streaming error";
        updateAssistant((prev: UiMessage) => ({
          status: "error",
          content: prev.content
            ? `${prev.content}\n\n⚠️ ${message}`
            : `⚠️ ${message}`,
        }));
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
        setComposerKey((k) => k + 1);
        setPendingApproval(null);
      }
    },
    [
      activeMessages,
      attachmentsRef,
      permissionMode,
      selectedModel,
      onWriteFileComplete,
    ],
  );

  const decideApproval = useCallback(
    async (decision: "allow" | "deny") => {
      const current = pendingApproval;
      if (!current) return;
      // Hide immediately so the UI feels responsive; the agent is still
      // streaming behind the scenes.
      setPendingApproval(null);
      try {
        await sendApproval(current.id, decision);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Approval request failed";
        console.warn(
          "[approval] send failed:",
          message,
          "— relying on server fail-close",
        );
      }
    },
    [pendingApproval],
  );

  return {
    isStreaming,
    liveUsage,
    pendingApproval,
    composerKey,
    treeVersion,
    send,
    stop,
    decideApproval,
  };
}
