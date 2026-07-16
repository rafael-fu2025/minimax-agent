// filepath: src/api.ts
import type {
  AgentEvent,
  ContentPart,
  FileContent,
  PermissionMode,
  SandboxRoot,
  SandboxTree,
  UiMessage,
} from "./types";
import type { UsageResponse } from "./types/usage";

/**
 * Discriminated union return type for fetches that previously returned
 * `T | null`. Now callers get either `{ok: true, data: T}` or
 * `{ok: false, error: string}` and can render the failure mode explicitly
 * instead of guessing "is it null because the server is down or because the
 * resource is missing?".
 */
export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/**
 * Sends the conversation history to the backend and yields every AgentEvent
 * as it arrives. Uses fetch + ReadableStream so we can abort via the
 * AbortController passed in by the caller.
 */
export async function* streamAgent(
  messages: UiMessage[],
  signal: AbortSignal,
  options?: { model?: string; permissionMode?: PermissionMode },
): AsyncGenerator<AgentEvent> {
  // Translate the UI message list into the server's wire format. Multimodal
  // user messages send their `attachments` array as the `content` field; text
  // only messages keep using the plain string shape.
  const wireMessages = messages.map((m) => {
    if (m.role === "user" && m.attachments && m.attachments.length > 0) {
      const parts: ContentPart[] = [];
      const trimmed = m.content.trim();
      if (trimmed) parts.push({ type: "text", text: trimmed });
      parts.push(...m.attachments);
      return { role: m.role, content: parts };
    }
    return { role: m.role, content: m.content };
  });

  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: wireMessages,
      model: options?.model,
      permissionMode: options?.permissionMode,
    }),
    signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Backend error ${res.status}: ${text || res.statusText || "unknown"}`,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE: events separated by blank lines.
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        for (const line of part.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload) continue;
          try {
            const event = JSON.parse(payload) as AgentEvent;
            yield event;
          } catch {
            // Skip malformed lines instead of crashing the whole stream.
          }
        }
      }
    }
    // Flush any trailing partial multi-byte UTF-8 sequence. `decode(value,
    // { stream: true })` above buffers incomplete sequences; calling with
    // no args (and no `stream`) emits whatever was buffered plus a
    // replacement character for any truly invalid bytes. Without this,
    // the last event in a stream can be silently lost when its payload
    // ends mid-character.
    const tail = decoder.decode();
    if (tail) {
      buffer += tail;
      const parts = buffer.split("\n\n");
      for (const part of parts) {
        for (const line of part.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload) continue;
          try {
            const event = JSON.parse(payload) as AgentEvent;
            yield event;
          } catch {
            // Skip malformed lines instead of crashing the whole stream.
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export interface HealthInfo {
  ok: boolean;
  model: string;
  hasKey: boolean;
}

export async function fetchHealth(): Promise<Result<HealthInfo>> {
  try {
    const res = await fetch("/api/health");
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    return { ok: true, data: (await res.json()) as HealthInfo };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export interface ModelLimit {
  id: string;
  context: number | null;
  maxOutput: number | null;
  known: boolean;
}

export interface ModelsResponse {
  models: string[];
  cached: boolean;
  fallback?: boolean;
  error?: string;
  limits: ModelLimit[];
}

/** Fetch the list of available model ids from the backend (cached 5 min). */
export async function fetchModels(): Promise<Result<ModelsResponse>> {
  try {
    const res = await fetch("/api/models");
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, data: (await res.json()) as ModelsResponse };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export interface ToolInfo {
  name: string;
  description: string;
  /** Either `"native"` or `"mcp:<serverName>"`. */
  source: string;
}

export interface ToolsResponse {
  tools: ToolInfo[];
  mcpServers: string[];
  sandboxRoot: string | null;
  memory: { dim: number; model: string; provider: "stub" | "minimax" };
  totals: { tools: number; native: number; mcp: number };
}

/** Fetch the live tool registry + server config snapshot. */
export async function fetchUsage(): Promise<Result<UsageResponse>> {
  try {
    const res = await fetch("/api/usage");
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, data: (await res.json()) as UsageResponse };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function fetchTools(): Promise<Result<ToolsResponse>> {
  try {
    const res = await fetch("/api/tools");
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, data: (await res.json()) as ToolsResponse };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Resolve a pending tool approval. POSTs `{decision}` to the matching
 * endpoint the server sent in the `approval_required` event. Returns
 * `{ok: true}` on success, `{ok: false, error}` if the id was unknown.
 * Throws on network failure (the caller should fall back to "deny").
 */
export async function sendApproval(
  approvalId: string,
  decision: "allow" | "deny",
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`/api/chat/approval/${encodeURIComponent(approvalId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision }),
  });
  let json: { ok?: boolean; error?: string } = {};
  try {
    json = (await res.json()) as { ok?: boolean; error?: string };
  } catch {
    // non-JSON body
  }
  if (!res.ok) {
    return { ok: false, error: json.error ?? `HTTP ${res.status}` };
  }
  return { ok: Boolean(json.ok), error: json.error };
}

/* -------------------------------------------------------------------------- */
/* Workspace Explorer (sandbox tree + file content)                            */
/* -------------------------------------------------------------------------- */

export async function fetchSandboxTree(
  opts: { path?: string; depth?: number } = {},
): Promise<Result<SandboxTree>> {
  const params = new URLSearchParams();
  if (opts.path) params.set("path", opts.path);
  if (opts.depth != null) params.set("depth", String(opts.depth));
  const url = `/api/sandbox/tree${params.toString() ? `?${params}` : ""}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, data: (await res.json()) as SandboxTree };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function fetchSandboxFile(
  path: string,
  opts: { maxBytes?: number } = {},
): Promise<Result<FileContent>> {
  const params = new URLSearchParams({ path });
  if (opts.maxBytes != null) params.set("max_bytes", String(opts.maxBytes));
  try {
    const res = await fetch(`/api/sandbox/file?${params}`);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, data: (await res.json()) as FileContent };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/* -------------------------------------------------------------------------- */
/* Active sandbox root (runtime-switchable)                                   */
/* -------------------------------------------------------------------------- */

export async function fetchSandboxRoot(): Promise<Result<SandboxRoot>> {
  try {
    const res = await fetch("/api/sandbox/root");
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, data: (await res.json()) as SandboxRoot };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Change the active sandbox root at runtime. Returns the resolved root on
 * success, or an error message if the server rejected the path.
 */
export async function setSandboxRoot(
  path: string,
): Promise<Result<SandboxRoot>> {
  let res: Response;
  try {
    res = await fetch("/api/sandbox/root", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  let json: { root?: string; error?: string } = {};
  try {
    json = (await res.json()) as { root?: string; error?: string };
  } catch {
    // fall through
  }
  if (!res.ok) {
    return { ok: false, error: json.error ?? `HTTP ${res.status}` };
  }
  return {
    ok: true,
    data: { root: json.root ?? "", isDefault: false, platform: "" },
  };
}

/**
 * Create a directory in the sandbox. `recursive` defaults to true so the
 * caller can use the same call for top-level and nested paths.
 */
export async function sandboxMkdir(
  path: string,
  recursive: boolean = true,
): Promise<Result<{ path: string }>> {
  let res: Response;
  try {
    res = await fetch("/api/sandbox/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  return readJson<{ path: string }>(res);
}

/**
 * Rename or move a file/dir within the sandbox. Refuses if `to` exists.
 */
export async function sandboxRename(
  from: string,
  to: string,
): Promise<Result<{ from: string; to: string }>> {
  let res: Response;
  try {
    res = await fetch("/api/sandbox/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, to }),
    });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  return readJson<{ from: string; to: string }>(res);
}

/**
 * Delete a file or directory. Pass `recursive: true` to allow non-empty
 * directories. The default is non-recursive so accidental clicks are safe.
 */
export async function sandboxDelete(
  path: string,
  _recursive: boolean = false,
): Promise<Result<{ path: string; trashPath: string }>> {
  let res: Response;
  try {
    res = await fetch("/api/sandbox/file", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  return readJson<{ path: string; trashPath: string }>(res);
}

export async function sandboxRestore(
  trashPath: string,
  originalPath: string,
): Promise<Result<{ path: string }>> {
  const res = await fetch("/api/sandbox/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trashPath, originalPath }),
  });
  return readJson<{ path: string }>(res);
}
/**
 * Upload a binary file to the sandbox. `path` is the destination path
 * relative to the sandbox root; the server creates any missing parent
 * directories automatically.
 */
export async function sandboxUpload(
  path: string,
  data: ArrayBuffer | Blob,
): Promise<Result<{ path: string; bytes: number }>> {
  let res: Response;
  try {
    res = await fetch(
      "/api/sandbox/upload?path=" + encodeURIComponent(path),
      { method: "POST", body: data },
    );
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  return readJson<{ path: string; bytes: number }>(res);
}

/** Small shared JSON reader for the endpoints above. */
async function readJson<T>(res: Response): Promise<Result<T>> {
  let json: T & { error?: string } = {} as T & { error?: string };
  try {
    json = (await res.json()) as T & { error?: string };
  } catch {
    // fall through
  }
  if (!res.ok) {
    return { ok: false, error: json.error ?? `HTTP ${res.status}` };
  }
  return { ok: true, data: json as T };
}
/* -------------------------------------------------------------------------- */
/* Multimodal uploads (MiniMax Files API proxy)                                */
/* -------------------------------------------------------------------------- */

/**
 * Upload a binary blob to the MiniMax Files API via the server proxy.
 * Used for large videos that exceed the 50 MB base64 limit — the server
 * forwards the file to `POST /v1/files/upload` with
 * `purpose: "video_understanding"`, then returns a `mm_file://{file_id}`
 * reference the client drops into a `video_url` content part.
 */
export interface UploadResult {
  ok: boolean;
  fileId?: string;
  bytes?: number;
  filename?: string;
  contentPart?: ContentPart;
  error?: string;
}

export async function uploadFile(opts: {
  file: File | Blob;
  filename: string;
  mime: string;
  purpose?: "video_understanding";
}): Promise<UploadResult> {
  const buf = new Uint8Array(await opts.file.arrayBuffer());
  // Base64-encode in chunks to avoid call-stack overflow on large files.
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    binary += String.fromCharCode(...buf.subarray(i, i + chunk));
  }
  const dataB64 = btoa(binary);

  let res: Response;
  try {
    res = await fetch("/api/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        purpose: opts.purpose ?? "video_understanding",
        filename: opts.filename,
        mime: opts.mime,
        data: dataB64,
      }),
    });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  let json: UploadResult = { ok: false };
  try {
    json = (await res.json()) as UploadResult;
  } catch {
    // fall through
  }
  if (!res.ok) {
    return { ok: false, error: json.error ?? `HTTP ${res.status}` };
  }
  return json;
}
