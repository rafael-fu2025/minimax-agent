// filepath: src/types.ts
export type Role = "user" | "assistant" | "system";

/* -------------------------------------------------------------------------- */
/* Multimodal content                                                          */
/* -------------------------------------------------------------------------- */

/** Mirrors the OpenAI-compatible content part shape (also what MiniMax M3
 * accepts). The `data:` URL form is used for client-side base64 embedding. */
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

export type MessageContent = string | ContentPart[];

/** Local-only attachment metadata for the composer preview chips. */
export interface AttachmentMeta {
  /** Stable id (uuid) so React can key the chip list. */
  id: string;
  /** Original filename. */
  name: string;
  /** MIME type, e.g. `image/png`, `video/mp4`, `application/pdf`. */
  mime: string;
  /** Size in bytes. */
  size: number;
  /** Convenience: image / video / pdf / other. */
  kind: "image" | "video" | "pdf" | "other";
  /** Object URL for the local preview (images + videos only). */
  previewUrl?: string;
  /**
   * The underlying `File` reference. Only present in the browser; never
   * serialized to the server. Used at send time to produce a `data:` URL
   * (for inline images / small videos) or to feed the Files API upload
   * (for large videos).
   */
  file?: File;
  /** For PDFs: number of pages to render. Defaults to 3. */
  pageCount?: number;
}

export interface UiMessage {
  id: string;
  role: Role;
  /** Visible (non-thinking) assistant text. */
  content: string;
  /**
   * Accumulated text from `<think>...</think>` blocks. Rendered in a
   * separate collapsible "Thinking" panel so it doesn't pollute the answer.
   */
  thinking?: string;
  /** Streaming state for the latest assistant message. */
  status?: "streaming" | "done" | "error";
  /** Tool invocations that happened while producing this assistant message. */
  toolCalls?: UiToolCall[];
  /**
   * Token usage for the assistant turn that produced this message.
   * Aggregated across all model + tool rounds in the agentic loop.
   */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** Multimodal parts sent on this user turn (images, videos, …). */
  attachments?: ContentPart[];
}

export interface UiToolCall {
  id: string;
  name: string;
  arguments: string;
  output?: string;
  status: "running" | "complete" | "error";
  durationMs?: number;
}

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      arguments: string;
    }
  | {
      type: "tool_result";
      id: string;
      name: string;
      output: string;
    }
  | {
      type: "usage";
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    }
  | { type: "done"; finishReason: string }
  | { type: "error"; message: string }
  | {
      /**
       * Server pauses the stream until the client POSTs a decision to
       * `/api/chat/approval/:id`. `preview` is a one-line human-readable
       * summary of the tool call (e.g. `$ rm -rf /tmp/x`). `arguments` is
       * the raw JSON string the model produced.
       */
      type: "approval_required";
      id: string;
      tool: string;
      arguments: string;
      preview: string;
    };

/** Permission mode sent to the server on every chat request. */
export type PermissionMode = "safe" | "accept-edits" | "bypass";

/* -------------------------------------------------------------------------- */
/* Workspace Explorer (sandbox tree + file preview)                            */
/* -------------------------------------------------------------------------- */

export type TreeKind = "dir" | "file";

export interface TreeNode {
  name: string;
  kind: TreeKind;
  size: number | null;
  /** Present iff `kind === "dir"` and the subtree was walked. */
  children?: TreeNode[];
  /** True when the walker hit depth or fan-out caps for this directory. */
  hasMore?: boolean;
  /** How many entries were truncated; present alongside `hasMore`. */
  truncatedChildCount?: number;
}

export interface SandboxTree {
  path: string;
  nodes: TreeNode[];
  /** Total entries skipped by fan-out caps across the whole response. */
  truncated: number;
}

export interface FileContent {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
}

export interface SandboxRoot {
  /** Resolved absolute path of the active sandbox root. */
  root: string;
  /** True when the root is the boot-time default (i.e. no `TOOL_SANDBOX_ROOT` env var was set). */
  isDefault: boolean;
  /** "win32" | "darwin" | "linux" | … — surfaced for the client to render hints. */
  platform: string;
}