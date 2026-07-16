// filepath: src/App.tsx
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useConversations } from "./hooks/useConversations";
import { useChat } from "./hooks/useChat";
import { useDraft } from "./hooks/useDraft";
import { useToasts } from "./hooks/useToasts";
import type { ContentPart } from "./types";
import { EMPTY_STATE } from "./emptyStateCopy";
import {
  ChatComposer,
  ChatLayout,
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  ChatMessageMetadata,
  ChatSystemMessage,
  ChatToolCalls,
  type ChatMessageSender,
  type ChatToolCallStatus,
} from "@astryxdesign/core/Chat";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HoverCard } from "@astryxdesign/core/HoverCard";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Selector } from "@astryxdesign/core/Selector";
import { SideNav, SideNavHeading, SideNavItem } from "@astryxdesign/core/SideNav";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "@astryxdesign/core/Table";
import { Token } from "@astryxdesign/core/Token";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { TopNav } from "@astryxdesign/core/TopNav";
import {
  CopyIcon,
  MessageCircleIcon,
  PlusIcon,
  RefreshCwIcon,
  TrashIcon,
  CpuIcon,
  BrainIcon,
  SettingsIcon,
} from "lucide-react";
import { fetchHealth, fetchModels, type HealthInfo, type ModelLimit } from "./api";
import { welcomeMessage } from "./defaults";
import type { AttachmentMeta, PermissionMode, UiMessage, UiToolCall } from "./types";
import { SettingsDialog } from "./components/SettingsDialog";
import { ApprovalDialog } from "./components/ApprovalDialog";
import { ToastHost } from "./components/ToastHost";
import { SidebarConversationRow } from "./components/SidebarConversationRow";
import { buildHelpText, type SlashCommand } from "./slashCommands";
import {
  PermissionModeSelector,
  readPersistedPermissionMode,
} from "./components/PermissionModeSelector";
import { WorkspaceExplorer } from "./components/WorkspaceExplorer";
import { MultimodalComposer } from "./components/MultimodalComposer";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function toToolStatus(raw: string, isFinal: boolean): ChatToolCallStatus {
  if (!isFinal) return "running";
  if (raw.startsWith("Error")) return "error";
  return "complete";
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function shortArgs(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= 80) return trimmed || "(no arguments)";
  return `${trimmed.slice(0, 77)}…`;
}

/** Compact human-readable token count: 1.2K, 47K, 1.04M. */
function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

/* -------------------------------------------------------------------------- */
import { MathBlock, MathInline, MathAwareContent } from "./components/MathContent";
/* -------------------------------------------------------------------------- */

const MODEL_STORAGE_KEY = "astryx-minimax-agent.selectedModel.v1";

function readStoredModel(): string | null {
  try {
    return localStorage.getItem(MODEL_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Build the options list for the model selector.
 * - If the API gave us a list, use it (deduplicated).
 * - Otherwise, fall back to a curated list of known models but still
 *   dedupe so the currently-selected model doesn't appear twice.
 */
function dedupedOptions(available: string[], current: string): string[] {
  const fallback = [
    current,
    "MiniMax-M3",
    "MiniMax-M2.7",
    "MiniMax-M2.7-highspeed",
    "MiniMax-M2.5",
    "MiniMax-M2.5-highspeed",
    "MiniMax-M2.1",
    "MiniMax-M2.1-highspeed",
    "MiniMax-M2",
  ];
  const source = available.length > 0 ? available : fallback;
  return Array.from(new Set(source));
}

function writeStoredModel(model: string) {
  try {
    localStorage.setItem(MODEL_STORAGE_KEY, model);
  } catch {
    // Ignore.
  }
}

/* -------------------------------------------------------------------------- */
/* App                                                                         */
/* -------------------------------------------------------------------------- */

export function App() {
  /* ----------------------------- state --------------------------------- */
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelListFallback, setModelListFallback] = useState(false);
  /** Per-model context window + max output caps (from `/api/models`). */
  const [modelLimits, setModelLimits] = useState<Record<string, ModelLimit>>(
    {},
  );
  const [selectedModel, setSelectedModel] = useState<string>(
    () => readStoredModel() ?? "MiniMax-M3",
  );
  /** Settings dialog visibility. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /**
   * Active permission mode for this session. Persisted to localStorage so it
   * survives reloads. The server is stateless with respect to mode — we send
   * the current value on every `/api/chat` request.
   */
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    () => readPersistedPermissionMode(),
  );
  /**
   * Relative path the user attached via "Ask the agent about this". When
   * set, the chip in the composer's `sendActions` is rendered. The path is
   * sent through the chat hook as a "Referring to:" prefix in handleSend.
   */
  const [pendingFileRef, setPendingFileRef] = useState<string | null>(null);

  /**
   * Per-attachment lookup for the `__upload:{id}` placeholders that the
   * composer hands us. The composer only knows about the chip's id; the
   * underlying `File` lives in this ref so we can resolve it later for
   * large-video uploads to the MiniMax Files API.
   */
  const attachmentsRef = useRef<Map<string, AttachmentMeta & { file: File }>>(
    new Map(),
  );

  /* ------------------- conversation + chat hooks ---------------------- */
  const {
    conversations,
    activeId,
    activeMessages,
    selectConversation,
    startNew,
    remove,
    rename,
    restore,
    setActiveMessages,
  } = useConversations({ welcome: welcomeMessage });

  const {
    isStreaming,
    liveUsage,
    pendingApproval,
    composerKey,
    treeVersion,
    send,
    stop,
    decideApproval,
  } = useChat({
    activeMessages,
    setActiveMessages,
    selectedModel,
    permissionMode,
    attachmentsRef,
  });

  /**
   * Composer draft. Persists the in-progress text per conversation so that
   * switching threads or refreshing the page never wipes the draft the
   * user is mid-typing. Cleared by the composer when a send completes.
   */
  const draft = useDraft(activeId);

  /**
   * Toast queue. Local to the shell; the host is rendered into a portal at
   * `document.body` so it stays above the composer dock and the workspace
   * sidebar regardless of stacking contexts.
   */
  const toasts = useToasts();

  /* ------------------------- hydration on mount ------------------------ */
  useEffect(() => {
    fetchHealth().then((r) => {
      if (r.ok) setHealth(r.data);
    });
    fetchModels().then((r) => {
      if (!r.ok) return;
      const models = r.data;
      setAvailableModels(models.models);
      setModelListFallback(Boolean(models.fallback));
      const map: Record<string, ModelLimit> = {};
      for (const l of models.limits) map[l.id] = l;
      setModelLimits(map);
      if (!readStoredModel() && models.models.length > 0) {
        const preferred = models.models.find((m) => m === "MiniMax-M3") ?? models.models[0];
        setSelectedModel(preferred);
        writeStoredModel(preferred);
      }
    });
  }, []);

  // Re-fetch the model list when the user opens Settings or refocuses the
  // window, so a server restart (or a manual key add) is picked up without
  // a hard browser refresh.
  const refetchModels = useCallback(() => {
    fetchModels().then((r) => {
      if (!r.ok) return;
      const models = r.data;
      setAvailableModels(models.models);
      setModelListFallback(Boolean(models.fallback));
      const map: Record<string, ModelLimit> = {};
      for (const l of models.limits) map[l.id] = l;
      setModelLimits(map);
    });
  }, []);

  useEffect(() => {
    if (!settingsOpen) return;
    refetchModels();
  }, [settingsOpen, refetchModels]);

  useEffect(() => {
    window.addEventListener("focus", refetchModels);
    return () => window.removeEventListener("focus", refetchModels);
  }, [refetchModels]);

  /* ------------------------- sidebar handlers ------------------------- */
  const handleSelect = useCallback(
    (id: string) => {
      stop(); // abort any in-flight stream before switching
      selectConversation(id);
    },
    [selectConversation, stop],
  );

  const handleNew = useCallback(() => {
    stop();
    startNew();
  }, [startNew, stop]);

  const handleDelete = useCallback(
    (id: string) => {
      stop();
      const deleted = remove(id);
      if (!deleted) return;
      // Sticky toast with an Undo affordance. ttlMs: 0 disables the
      // auto-dismiss; the user has to either Undo or close it.
      toasts.push({
        variant: "warning",
        message: `Deleted "${deleted.title || "New conversation"}"`,
        action: {
          label: "Undo",
          onClick: () => {
            const restored = restore(deleted);
            if (restored) {
              selectConversation(restored);
              toasts.push({
                variant: "success",
                message: "Conversation restored",
                ttlMs: 1800,
              });
            } else {
              toasts.push({
                variant: "error",
                message: "Could not restore conversation",
                ttlMs: 4000,
              });
            }
          },
        },
      });
    },
    [remove, restore, selectConversation, stop, toasts],
  );

  /**
   * Slash command dispatcher. The composer has already applied any text
   * replacement; we only need to act on the "action" commands (clear,
   * help, rename). For "prompt" commands the slug is already replaced
   * with a stub and the user will hit send themselves.
   */
  const handleSlashCommand = useCallback(
    (cmd: SlashCommand, args: string) => {
      switch (cmd.slug) {
        case "/clear": {
          // Drop every message and re-seed the welcome message. We keep
          // the same conversation id so the sidebar ordering does not
          // shift under the user.
          setActiveMessages(() => [welcomeMessage]);
          toasts.push({
            variant: "success",
            message: "Conversation cleared",
            ttlMs: 1800,
          });
          break;
        }
        case "/help": {
          toasts.push({
            variant: "info",
            message: "Slash commands",
            description: buildHelpText(),
            ttlMs: 10000,
          });
          break;
        }
        case "/rename": {
          if (!activeId) {
            toasts.push({
              variant: "warning",
              message: "No active conversation to rename",
              ttlMs: 3000,
            });
            return;
          }
          const trimmed = args.trim();
          if (!trimmed) {
            toasts.push({
              variant: "warning",
              message: "Usage: /rename New title",
              ttlMs: 3000,
            });
            return;
          }
          const updated = rename(activeId, trimmed);
          if (updated) {
            toasts.push({
              variant: "success",
              message: `Renamed to "${updated.title}"`,
              ttlMs: 1800,
            });
          }
          break;
        }
        default:
          // "prompt" commands are handled by the composer itself; the
          // user will send the message.
          break;
      }
    },
    [activeId, rename, setActiveMessages, toasts],
  );

  /* ------------------------- model selector --------------------------- */
  const handleModelChange = useCallback((value: string) => {
    setSelectedModel(value);
    writeStoredModel(value);
  }, []);

  /* ----------------------------- send --------------------------------- */
  // Capture the "Referring to: <path>" prefix inline so the hook sees a
  // resolved string instead of a state read at the wrong moment.
  const handleSend = useCallback(
    async (text: string, attachmentParts: ContentPart[] = []) => {
      if (isStreaming) return;
      const fileRef = pendingFileRef;
      const prefix = fileRef ? `Referring to: ${fileRef}\n` : "";
      if (fileRef) setPendingFileRef(null);
      await send(prefix + text, attachmentParts);
    },
    [isStreaming, pendingFileRef, send],
  );

  /* ------------------------------ stop -------------------------------- */
  // Wrapper around the `useChat.stop` action so the <MultimodalComposer>
  // can call it via the `onStop` prop. Aborts the in-flight SSE stream;
  // any in-flight large-video Files API upload cannot be aborted from the
  // server side (the request is already on the wire), but the client
  // will see the assistant bubble wrap up on the next tick.
  const handleStop = useCallback(() => {
    stop();
  }, [stop]);

  /* ------------------------- message actions --------------------------- */
  // Per-bubble helpers used by the inline `message-actions` row.
  //
  // - `handleCopy`: best-effort clipboard write of the bubble text.
  // - `handleRetry`: drops the final user+assistant pair from the active
  //   conversation and resends the user text. Skipped while streaming.
  // - `handleDeleteAfter`: removes the target message and every later
  //   message, a simple everything-from-here deletion.
  const handleCopy = useCallback(
    async (text: string) => {
      try {
        if (!text) return;
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          toasts.push({ variant: "success", message: "Copied to clipboard", ttlMs: 1800 });
          return;
        }
        throw new Error("Clipboard API unavailable");
      } catch (err) {
        toasts.push({
          variant: "warning",
          message: "Could not copy",
          description:
            err instanceof Error ? err.message : "The clipboard blocked this write.",
          ttlMs: 4000,
        });
      }
    },
    [toasts],
  );

  const handleRetry = useCallback(
    async (messageId: string) => {
      if (isStreaming) return;
      // Find the target message and walk back to the nearest preceding
      // user message. If we cannot find one we cannot retry.
      const idx = activeMessages.findIndex((m) => m.id === messageId);
      if (idx < 0) return;
      let userIdx = -1;
      for (let i = idx - 1; i >= 0; i--) {
        if (activeMessages[i].role === "user") {
          userIdx = i;
          break;
        }
      }
      if (userIdx < 0) return;
      const userMsg = activeMessages[userIdx];
      const attachments = userMsg.attachments ?? [];
      // Drop the assistant and everything from the user message onward so
      // the conversation reflects the state right before the user asked.
      setActiveMessages((prev) => prev.slice(0, userIdx));
      // Replay through the normal send pipeline so the optional referring
      // prefix still gets applied.
      await handleSend(userMsg.content, attachments);
    },
    [activeMessages, handleSend, isStreaming, setActiveMessages],
  );

  const handleDeleteAfter = useCallback(
    (messageId: string) => {
      const idx = activeMessages.findIndex((m) => m.id === messageId);
      if (idx < 0) return;
      if (idx === 0) {
        // Wipe back to the welcome message so the bubble list stays valid.
        setActiveMessages(() => []);
        return;
      }
      setActiveMessages((prev) => prev.slice(0, idx));
    },
    [activeMessages, setActiveMessages],
  );

  /* ------------------------- approval decisions ----------------------- */
  // Wire the <ApprovalDialog>'s `onResolve` callback to the `useChat`
  // `decideApproval` action. The dialog calls us with the user's
  // "allow" / "deny" choice; we forward it to the hook which posts the
  // decision to `/api/chat/approval/:id` and resolves the in-flight
  // agent-loop promise that was awaiting this answer.
  const handleApprovalDecision = useCallback(
    (decision: "allow" | "deny") => {
      void decideApproval(decision);
    },
    [decideApproval],
  );

  /* ---------------------- derived view state -------------------------- */
  const showMissingKeyBanner =
    health !== null && !health.hasKey && !bannerDismissed;

  const isEmpty = activeMessages.length <= 1;

  // Total tokens used by every assistant turn in the active conversation.
  // Falls back to the live in-flight value while a stream is in progress so
  // the context bar updates as the model emits usage chunks.
  const totalUsage = useMemo(() => {
    let prompt = 0;
    let completion = 0;
    let total = 0;
    for (const m of activeMessages) {
      if (m.role === "assistant" && m.usage) {
        prompt += m.usage.promptTokens;
        completion += m.usage.completionTokens;
        total += m.usage.totalTokens;
      }
    }
    if (liveUsage) {
      // Override with the most recent running total from the active stream.
      // The active stream's per-turn usage is *cumulative*, so it dominates
      // any older totals we may have aggregated above for the same turn.
      if (isStreaming) {
        prompt = liveUsage.promptTokens;
        completion = liveUsage.completionTokens;
        total = liveUsage.totalTokens;
      }
    }
    return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
  }, [activeMessages, liveUsage, isStreaming]);

  const contextLimit = modelLimits[selectedModel]?.context ?? null;
  const contextPercent =
    contextLimit && contextLimit > 0
      ? Math.min(100, (totalUsage.totalTokens / contextLimit) * 100)
      : 0;
  const contextVariant: "neutral" | "accent" | "warning" | "error" =
    contextPercent >= 95
      ? "error"
      : contextPercent >= 80
        ? "warning"
        : "accent";

  return (
    <div className="app-root">
      {/* ============================================================= */}
      {/* Top bar                                                        */}
      {/* ============================================================= */}
      <TopNav
        label="Astryx × MiniMax Agent"
        endContent={
          <div className="topnav-end">
            <div className="topnav-end__model-selector">
              <Selector
                label="Model"
                isLabelHidden
                size="sm"
                value={selectedModel}
                onChange={handleModelChange}
                options={dedupedOptions(availableModels, selectedModel)}
                startIcon={<Icon icon={CpuIcon} size="sm" />}
                hasSearch={availableModels.length > 6}
                placeholder="Choose a model"
                width={240}
                status={
                  modelListFallback
                    ? { type: "warning", message: "Using fallback list" }
                    : undefined
                }
              />
            </div>
            <StatusDot
              variant={health?.hasKey ? "success" : "warning"}
              label={health?.hasKey ? "Connected" : "No API key"}
            />
            <IconButton
              label="Settings"
              onClick={() => setSettingsOpen(true)}
              size="sm"
              icon={<Icon icon={SettingsIcon} size="md" />}
              variant="ghost"
            />
            <IconButton
              label="New conversation"
              onClick={handleNew}
              size="sm"
              icon={<Icon icon={PlusIcon} size="md" />}
              variant="ghost"
            />
          </div>
        }
      />

      {/* ============================================================= */}
      {/* Body: left chats | centered chat | right workspace            */}
      {/* ============================================================= */}
      <div className="app-body">
        <SideNav
          collapsible
          header={
            <SideNavHeading
              heading="Conversations"
              subheading={`${conversations.length} saved`}
            />
          }
          topContent={
            <Button
              label="New chat"
              variant="primary"
              onClick={handleNew}
              icon={<Icon icon={PlusIcon} size="md" />}
            />
          }
        >
          {conversations.length === 0 && (
            <div className="side-empty">No conversations yet.</div>
          )}
          {conversations.map((c) => (
            <SidebarConversationRow
              key={c.id}
              id={c.id}
              title={c.title}
              isSelected={c.id === activeId}
              onSelect={handleSelect}
              onDelete={handleDelete}
              onRename={(id, title) => {
                const updated = rename(id, title);
                return updated !== null;
              }}
              onNotify={(t) => toasts.push(t)}
            />
          ))}
        </SideNav>

        <main className="app-main">
          {showMissingKeyBanner && (
            <div className="banner-slot">
              <Banner
                status="warning"
                title="No chat API key configured"
                description="The chat will fail until you add a key. Add one in Settings → Keys, or set MINIMAX_API_KEY in .env and restart."
                isDismissable
                onDismiss={() => setBannerDismissed(true)}
                endContent={
                  <Button
                    label="Copy .env.example"
                    variant="ghost"
                    onClick={() => {
                      void handleCopy("MINIMAX_API_KEY=sk-minimax-your-key-here\n");
                    }}
                  />
                }
              />
            </div>
          )}

          <ChatLayout
            density="balanced"
            composer={
              <MultimodalComposer
                key={composerKey}
                placeholder={
                  isStreaming ? "Thinking…" : "Ask anything to get started"
                }
                isDisabled={isStreaming}
                isStopShown={isStreaming}
                onSubmit={handleSend}
                onStop={handleStop}
                value={draft.value}
                onValueChange={draft.setValue}
                onAfterSubmit={draft.clear}
                onSlashCommand={handleSlashCommand}
                onAttachmentsChange={(next) => {
                  // Keep the parent-side file lookup in sync with the
                  // composer's chip list so we can resolve `__upload:{id}`
                  // placeholders to the actual `File` on send.
                  const map = attachmentsRef.current;
                  const seen = new Set<string>();
                  for (const a of next) {
                    // @ts-expect-error - `file` is added by the composer at
                    // runtime; it's not on the public AttachmentMeta type.
                    if (a.file) map.set(a.id, a);
                    seen.add(a.id);
                  }
                  for (const id of Array.from(map.keys())) {
                    if (!seen.has(id)) map.delete(id);
                  }
                }}
                onAttachmentsSent={() => {
                  attachmentsRef.current.clear();
                }}
                sendActions={
                  <div className="composer-send-actions">
                    {pendingFileRef && (
                      <Token
                        label={`📎 ${pendingFileRef}`}
                        onRemove={() => setPendingFileRef(null)}
                      />
                    )}
                    <PermissionModeSelector
                      value={permissionMode}
                      onChange={setPermissionMode}
                      isDisabled={isStreaming}
                    />
                    <ContextTrigger
                      modelName={selectedModel}
                      totalTokens={totalUsage.totalTokens}
                      contextLimit={contextLimit}
                      promptTokens={totalUsage.promptTokens}
                      completionTokens={totalUsage.completionTokens}
                      variant={
                        contextPercent >= 95
                          ? "error"
                          : contextPercent >= 80
                            ? "warning"
                            : "accent"
                      }
                      percent={contextPercent}
                    />
                  </div>
                }
              />
            }
          >
            <ChatMessageList>
              {isEmpty && (
                <EmptyState
                  icon={<Icon icon={BrainIcon} size="lg" />}
                  title={EMPTY_STATE.title}
                  description={EMPTY_STATE.description}
                  actions={
                    <div className="empty-actions">
                      <Button
                        label={EMPTY_STATE.suggestions[0].label}
                        variant="secondary"
                        onClick={() => handleSend(EMPTY_STATE.suggestions[0].prompt)}
                      />
                      <Button
                        label={EMPTY_STATE.suggestions[1].label}
                        variant="secondary"
                        onClick={() => handleSend(EMPTY_STATE.suggestions[1].prompt)}
                      />
                      <Button
                        label={EMPTY_STATE.suggestions[2].label}
                        variant="secondary"
                        onClick={() => handleSend(EMPTY_STATE.suggestions[2].prompt)}
                      />
                    </div>
                  }
                />
              )}

              {(() => {
                let lastAssistantId = null;
                for (let i = activeMessages.length - 1; i >= 0; i--) {
                  if (activeMessages[i].role === "assistant") {
                    lastAssistantId = activeMessages[i].id;
                    break;
                  }
                }
                return activeMessages.map((msg) => (
                  <MessageBubble
                    key={msg.id}
                    message={msg}
                    canRetry={!isStreaming && msg.id === lastAssistantId}
                    onCopy={handleCopy}
                    onRetry={handleRetry}
                    onDeleteAfter={handleDeleteAfter}
                  />
                ));
              })()}

              {isStreaming && (
                <div
                  className="streaming-row"
                  aria-label="Assistant is thinking"
                >
                  <div className="streaming-row__skeletons">
                    <Skeleton width="62%" height={14} index={0} />
                    <Skeleton width="84%" height={14} index={1} />
                    <Skeleton width="48%" height={14} index={2} />
                  </div>
                </div>
              )}
            </ChatMessageList>
          </ChatLayout>
        </main>

        <SideNav
          header={
            <SideNavHeading
              heading="Workspace"
              subheading="Sandbox files"
            />
          }
        >
          <WorkspaceExplorer
            treeVersion={treeVersion}
            onAskAgent={(relPath) => setPendingFileRef(relPath)}
            onNotify={(t) => toasts.push(t)}
          />
        </SideNav>
      </div>

      <SettingsDialog
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />

      <ApprovalDialog
        approval={pendingApproval}
        mode={permissionMode}
        onResolve={handleApprovalDecision}
      />

      <ToastHost toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Circular context progress (custom SVG ring + Astryx HoverCard)              */
/* -------------------------------------------------------------------------- */

interface CircularProgressProps {
  /** Value 0..1 (or >1 for overflow). */
  fraction: number;
  /** Diameter in pixels. */
  size?: number;
  /** Stroke width in pixels. */
  stroke?: number;
  /** Visual tone. */
  variant: "accent" | "warning" | "error" | "success";
  /** Accessible label for the SVG. */
  ariaLabel: string;
}

function CircularProgress({
  fraction,
  size = 18,
  stroke = 2.5,
  variant,
  ariaLabel,
}: CircularProgressProps) {
  // Clamp negative values; allow >1 so the ring still closes at overflow.
  const pct = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - pct);

  // Match the circular ring's accent / warning / error token mapping so
  // the visual language stays consistent.
  const strokeColor =
    variant === "error"
      ? "var(--color-text-error, #e3193b)"
      : variant === "warning"
        ? "var(--color-text-warning, #c98507)"
        : variant === "success"
          ? "var(--color-text-success, #0d8626)"
          : "var(--color-text-accent, #1877f2)";

  return (
    <svg
      className="circular-progress"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={ariaLabel}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--color-border, #e5e7eb)"
        strokeWidth={stroke}
      />
      <circle
        className="circular-progress__fill"
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={strokeColor}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

interface ContextTriggerProps {
  modelName: string;
  totalTokens: number;
  contextLimit: number | null;
  promptTokens: number;
  completionTokens: number;
  variant: "neutral" | "accent" | "warning" | "error";
  percent: number;
}

/**
 * Renders the circular progress ring in the composer footer. Hovering (or
 * focusing) opens an Astryx `HoverCard` with the full token breakdown.
 */
function ContextTrigger(props: ContextTriggerProps) {
  const {
    modelName,
    totalTokens,
    contextLimit,
    promptTokens,
    completionTokens,
    variant,
    percent,
  } = props;
  const fraction = contextLimit && contextLimit > 0
    ? Math.min(1, totalTokens / contextLimit)
    : 0;

  // If we have no known context limit, show a neutral ring with a small
  // "?" mark so the user can still hover to see token usage.
  const noLimit = contextLimit == null;
  const ariaLabel = noLimit
    ? `${totalTokens} tokens used in this conversation`
    : `${percent.toFixed(1)}% of ${modelName} context window used (${totalTokens} of ${contextLimit} tokens)`;

  return (
    <HoverCard
      placement="above"
      alignment="end"
      delay={120}
      hideDelay={80}
      hasHoverIndication={false}
      content={
        <div className="context-hover" data-testid="context-hover">
          <div className="context-hover__header">
            <span className="context-hover__title">Context usage</span>
            <span className="context-hover__model">{modelName}</span>
          </div>

          <div className="context-hover__row">
            <CircularProgress
              fraction={fraction}
              variant={
                variant === "error"
                  ? "error"
                  : variant === "warning"
                    ? "warning"
                    : "accent"
              }
              size={56}
              stroke={5}
              ariaLabel={ariaLabel}
            />
            <div className="context-hover__counts">
              <div className="context-hover__percent">
                {noLimit
                  ? formatTokenCount(totalTokens)
                  : `${percent.toFixed(1)}%`}
              </div>
              <div className="context-hover__of">
                {noLimit
                  ? "tokens used"
                  : `${formatTokenCount(totalTokens)} of ${formatTokenCount(contextLimit!)}`}
              </div>
            </div>
          </div>

          <div className="context-hover__bar">
            <div className="context-hover__bar-row">
              <span className="context-hover__bar-label">Input</span>
              <span className="context-hover__bar-value">
                {formatTokenCount(promptTokens)}
              </span>
            </div>
            <div className="context-hover__bar-row">
              <span className="context-hover__bar-label">Output</span>
              <span className="context-hover__bar-value">
                {formatTokenCount(completionTokens)}
              </span>
            </div>
          </div>

          {!noLimit && (
            <div className="context-hover__hint">
              The model is told the full conversation each turn, so this bar
              grows as the thread gets longer.
            </div>
          )}
        </div>
      }
    >
      <button
        type="button"
        className="context-trigger"
        aria-label={ariaLabel}
        title={ariaLabel}
      >
        <CircularProgress
          fraction={fraction}
          variant={
            variant === "error"
              ? "error"
              : variant === "warning"
                ? "warning"
                : "accent"
          }
          ariaLabel={ariaLabel}
        />
      </button>
    </HoverCard>
  );
}

/* -------------------------------------------------------------------------- */
/* Message bubble (no avatar / no sender name)                                 */
/* -------------------------------------------------------------------------- */

interface MessageBubbleProps {
  message: UiMessage;
  /** When true, the bubble renders a "Try again" affordance. */
  canRetry?: boolean;
  /** Copy the bubble text to the clipboard. */
  onCopy: (text: string) => void;
  /** Retry the assistant turn this bubble belongs to. */
  onRetry: (messageId: string) => void;
  /** Delete the target message and every later message. */
  onDeleteAfter: (messageId: string) => void;
}

function MessageBubble({
  message,
  canRetry,
  onCopy,
  onRetry,
  onDeleteAfter,
}: MessageBubbleProps) {
  const isAssistant = message.role === "assistant";
  const isUser = message.role === "user";
  const sender: ChatMessageSender = isAssistant ? "assistant" : "user";
  const bubbleVariant: "filled" | "ghost" = isAssistant ? "ghost" : "filled";
  const metaStatus =
    message.status === "streaming"
      ? "sending"
      : message.status === "error"
        ? "error"
        : "read";

  const hasThinking =
    isAssistant && (message.thinking ?? "").trim().length > 0;

  return (
    <ChatMessage sender={sender}>
      <ChatMessageBubble variant={bubbleVariant}>
        {isAssistant && message.toolCalls && message.toolCalls.length > 0 && (
          <ChatToolCalls
            calls={message.toolCalls.map((tc) => ({
              key: tc.id,
              name: tc.name,
              target: shortArgs(tc.arguments),
              duration:
                tc.durationMs !== undefined
                  ? formatDuration(tc.durationMs)
                  : tc.status === "running"
                    ? "running…"
                    : undefined,
              status: toToolStatus(
                tc.output ?? "",
                tc.status === "complete" || tc.status === "error",
              ),
              resultDetail: <ToolResultWidget tool={tc} />,
            }))}
          />
        )}

        {hasThinking && (
          <div className="thinking-block">
            <Collapsible
              defaultIsOpen={false}
              trigger={
                <span className="thinking-block__trigger">
                  <Icon icon={BrainIcon} size="sm" />
                  <span>Thinking</span>
                </span>
              }
            >
              <CodeBlock
                code={(message.thinking ?? "").trim()}
                language="text"
                hasCopyButton
                container="section"
                isCollapsible
                collapsibleThreshold={400}
                maxHeight={320}
              />
            </Collapsible>
          </div>
        )}

        {!isAssistant &&
          message.attachments &&
          message.attachments.length > 0 && (
            <div className="message-attachments">
              {message.attachments.map((part, i) => {
                if (part.type === "image_url") {
                  return (
                    <img
                      key={`img-${i}`}
                      src={part.image_url.url}
                      alt=""
                      className="message-attachments__image"
                    />
                  );
                }
                if (part.type === "video_url") {
                  return (
                    <video
                      key={`vid-${i}`}
                      src={part.video_url.url}
                      className="message-attachments__video"
                      controls
                      preload="metadata"
                    />
                  );
                }
                return null;
              })}
            </div>
          )}

        {isAssistant ? (
          <MathAwareContent
            content={message.content}
            isStreaming={message.status === "streaming"}
          />
        ) : (
          <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>
            {message.content}
          </p>
        )}

        {message.status === "streaming" && message.content.length === 0 && (
          <span className="thinking-dot" aria-hidden="true" />
        )}
      </ChatMessageBubble>

      <ChatMessageMetadata
        timestamp={<Timestamp value={Date.now()} format="time" />}
        status={metaStatus}
      />

      {isAssistant && message.status === "error" && (
        <div className="message-system">
          <ChatSystemMessage variant="default">
            The agent reported an error while producing this response.
          </ChatSystemMessage>
        </div>
      )}

      {message.status !== "streaming" && (
        <div className="message-actions" role="toolbar" aria-label="Message actions">
          <IconButton
            label="Copy message"
            size="sm"
            variant="ghost"
            onClick={() => onCopy(message.content)}
            icon={<Icon icon={CopyIcon} size="sm" />}
            isDisabled={!message.content}
          />
          {canRetry && (
            <IconButton
              label="Try again"
              size="sm"
              variant="ghost"
              onClick={() => onRetry(message.id)}
              icon={<Icon icon={RefreshCwIcon} size="sm" />}
            />
          )}
          <IconButton
            label="Delete this turn and everything after"
            size="sm"
            variant="ghost"
            onClick={() => onDeleteAfter(message.id)}
            icon={<Icon icon={TrashIcon} size="sm" />}
          />
        </div>
      )}
    </ChatMessage>
  );
}

/* -------------------------------------------------------------------------- */
/* Tool result widget — picks a richer renderer per tool                       */
/* -------------------------------------------------------------------------- */

function ToolResultWidget({ tool }: { tool: UiToolCall }) {
  const output = tool.output ?? "";
  // Both the historical native name and MiniMax's MCP web_search tool go
  // through the same `[n] title\nsnippet\nurl` parser. If the output doesn't
  // match the format, we fall through to a plain CodeBlock.
  if (tool.name === "web_search" || tool.name === "mcp_minimax_web_search") {
    const rows = parseSearchOutput(output);
    if (rows.length > 0) {
      return (
        <div className="tool-widget">
          <CodeBlock
            code={output}
            language="text"
            maxHeight={180}
            isCollapsible
            hasCopyButton
            container="section"
          />
          <Table density="compact" dividers="rows" hasHover>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>#</TableHeaderCell>
                <TableHeaderCell>Title</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.n}>
                  <TableCell>[{r.n}]</TableCell>
                  <TableCell>
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {r.title}
                    </a>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      );
    }
  }
  return (
    <CodeBlock
      code={output}
      language="text"
      maxHeight={220}
      isCollapsible
      collapsibleThreshold={240}
      hasCopyButton
      container="section"
    />
  );
}

interface SearchRow {
  n: number;
  title: string;
  url: string;
}

function parseSearchOutput(output: string): SearchRow[] {
  // web_search results are formatted as "[n] title\nsnippet\nurl" blocks.
  const blocks = output.split(/\n\n+/);
  const rows: SearchRow[] = [];
  for (const block of blocks) {
    const m = block.match(/^\[(\d+)\]\s+(.+?)\n[\s\S]*?\n(https?:\/\/\S+)/);
    if (m) {
      rows.push({ n: Number(m[1]), title: m[2].trim(), url: m[3].trim() });
    }
  }
  return rows;
}


