/**
 * Express entry point.
 * - POST /api/chat           -> runs the agent loop and streams SSE events back
 * - GET  /api/health         -> simple readiness check
 * - GET  /api/health/db      -> DB-specific readiness (503 when not configured)
 * - GET  /api/models         -> list available model ids + per-model limits
 * - GET    /api/conversations        -> list (limit, offset)
 * - POST   /api/conversations        -> create (returns the new row)
 * - GET    /api/conversations/:id    -> row + messages in sequence order
 * - PATCH  /api/conversations/:id    -> title
 * - DELETE /api/conversations/:id    -> cascade delete
 *
 * `POST /api/chat` accepts an optional `conversationId`. When present and
 * the persistence layer is configured, every user / assistant / tool turn
 * is persisted best-effort; failures are logged but never break the stream.
 */

import "dotenv/config";
import express, { type Response as ExpressResponse } from "express";
import cors from "cors";
import { getModelLimits, runAgent } from "./agent.js";
import { getConfig, listModels } from "./minimax.js";
import { KNOWN_MODELS } from "./models.js";
import { initTools, shutdownTools, tools } from "./tools.js";
import { startScheduler, stopScheduler } from "./tools/scheduler.js";
import { getSandboxRoot } from "./tools/sandbox.js";
import { mountSandboxRouter } from "./routers/sandbox.router.js";
import { eq } from "drizzle-orm";
import { isDbConfigured, pingDb, getDb } from "./db/index.js";
import {
  appendMessage,
  ensureConversation,
  setLastError,
} from "./db/conversations.js";
import { mountConversationsRouter } from "./routers/conversations.router.js";
import { buildRecallBlock, indexMessage, retrieveTopK } from "./memory.js";
import { getEmbeddings } from "./embeddings.js";
import { safeMemory, safePersistence } from "./persistence.js";
import { resolveApproval } from "./approvals.js";
import { parseApprovalMode } from "./tools/approval.js";

const app = express();
app.use(cors());

// 80 MB global JSON body cap. The frontend validates inline images at 10 MB
// and inline videos at 50 MB (base64-expanded to ~67 MB on the wire), so
// 80 MB leaves headroom without opening the door to absurd payloads. The
// `/api/uploads` route below installs a separate 800 MB cap for the dedicated
// file-upload endpoint (single base64 video stream).
app.use(express.json({ limit: "80mb" }));

// Larger body cap for the file-upload route — base64-encoded videos can
// approach 720 MB (512 MB binary × 4/3). This is registered after the
// default `express.json` so it doesn't override the global 80 MB cap.
const uploadJson = express.json({ limit: "800mb" });

/** Tiny in-memory model cache so the dropdown loads fast on subsequent calls. */
let modelCache: { at: number; ids: string[] } | null = null;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

app.get("/api/health", async (_req, res) => {
  const cfg = getConfig();
  // hasKey is true if either a *real* env-var key is set OR at least one
  // DB-stored active key exists. The env-var key is optional now — keys
  // are managed via Settings → Keys. We also filter out the .env.example
  // placeholder so a fresh checkout doesn't claim to be "Connected" just
  // because the placeholder is set.
  const envKey = cfg.apiKey?.trim() ?? "";
  const envKeyIsReal = envKey.length > 0 && !isPlaceholderKey(envKey);
  let dbHasActiveKey = false;
  if (isDbConfigured()) {
    try {
      const schema = await import("./db/schema.js");
      const rows = await getDb()
        .select({ id: schema.minimaxKeys.id })
        .from(schema.minimaxKeys)
        .where(eq(schema.minimaxKeys.status, "active"))
        .limit(1);
      dbHasActiveKey = rows.length > 0;
    } catch {
      // Table missing or other boot issue — fall through.
    }
  }
  res.json({
    ok: true,
    model: cfg.defaultModel,
    hasKey: envKeyIsReal || dbHasActiveKey,
  });
});

app.get("/api/health/db", async (_req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ ok: false, error: "database not configured" });
    return;
  }
  const result = await pingDb();
  if (result.ok) {
    res.json({ ok: true });
  } else {
    res.status(503).json({ ok: false, error: result.error });
  }
});

/**
 * Public config snapshot. No auth (the auth slice hasn't shipped yet). Used
 * by the React client to render the settings panel.
 */
/* -------------------------------------------------------------------------- */
/* MiniMax API key management (personal-use, single-tenant)                   */
/* -------------------------------------------------------------------------- */

import { mountKeysRouter } from "./routers/keys.router.js";
import { isPlaceholderKey } from "./keys/index.js";

mountKeysRouter(app);

app.get("/api/tools", (_req, res) => {
  // Prefer the `source` field on the ToolDefinition (set by the MCP merge
  // step) so we never have to parse server names out of the namespaced
  // tool name — that broke for MCP servers whose name contained an
  // underscore. Fall back to the name-prefix heuristic for tools that
  // never got a `source` (e.g. the two hand-written native tools).
  const toolRows = tools.map((t) => ({
    name: t.name,
    description: t.description,
    source: t.source
      ? `mcp:${t.source}`
      : t.name.startsWith("mcp_")
        ? `mcp:${t.name.slice(4).split("_", 1)[0]}`
        : "native",
  }));
  const mcpServers = Array.from(
    new Set(
      toolRows
        .filter((r) => r.source !== "native")
        .map((r) => r.source.slice(4)),
    ),
  ).sort();
  const native = toolRows.filter((r) => r.source === "native").length;
  const mcp = toolRows.length - native;

  res.json({
    tools: toolRows,
    mcpServers,
    sandboxRoot: process.env.TOOL_SANDBOX_ROOT ? getSandboxRoot() : null,
    memory: {
      dim: Number(process.env.EMBEDDING_DIM ?? 1024),
      model: process.env.EMBEDDING_MODEL ?? "embo-001",
      // Treat the .env.example placeholder the same as no key, so the UI
      // (memory.provider badge) does not claim a real MiniMax provider
      // when the embeddings client will silently fall back to Stub.
      provider:
        process.env.EMBEDDING_PROVIDER === "stub" ||
        !process.env.MINIMAX_API_KEY ||
        isPlaceholderKey(process.env.MINIMAX_API_KEY)
          ? "stub"
          : "minimax",
    },
    totals: { tools: toolRows.length, native, mcp },
  });
});

app.get("/api/usage", async (_req, res) => {
  try {
    const { fetchUsage } = await import("./minimax-usage.js");
    const data = await fetchUsage();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/models", async (_req, res) => {
  const now = Date.now();
  if (modelCache && now - modelCache.at < MODEL_CACHE_TTL_MS) {
    res.json(enrichWithLimits(modelCache.ids, true, false));
    return;
  }
  try {
    const models = await listModels();
    const ids = models.map((m) => m.id);
    if (ids.length > 0) {
      modelCache = { at: now, ids };
      res.json(enrichWithLimits(ids, false, false));
    } else {
      res.json(enrichWithLimits([], false, false));
    }
  } catch (err) {
    // Don't fail the whole app — fall back to a curated list of known models.
    res.json(
      enrichWithLimits(
        [...KNOWN_MODELS],
        false,
        true,
        (err as Error).message,
      ),
    );
  }
});

/**
 * Decorate a list of model ids with their per-model context window and
 * max output cap, so the client can render a live token-usage bar.
 */
function enrichWithLimits(
  ids: string[],
  cached: boolean,
  fallback: boolean,
  error?: string,
) {
  return {
    models: ids,
    cached,
    fallback,
    error,
    limits: ids.map((id) => {
      const limits = getModelLimits(id);
      return {
        id,
        context: limits?.context ?? null,
        maxOutput: limits?.maxOutput ?? null,
        known: Boolean(limits),
      };
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Conversation routes                                                        */
/* -------------------------------------------------------------------------- */

mountConversationsRouter(app);

/* -------------------------------------------------------------------------- */
/* /api/chat                                                                  */
/* -------------------------------------------------------------------------- */

app.post("/api/chat", async (req, res) => {
  const abortController = new AbortController();
  // Only abort when the client disconnects BEFORE we've finished writing the
  // response. Once `res.writableEnded` is true, ignore "close" so we don't
  // abort the in-flight fetch to MiniMax right as the response is finishing.
  let responseFinished = false;
  res.on("close", () => {
    if (!responseFinished) abortController.abort();
  });
  res.on("finish", () => {
    responseFinished = true;
  });

  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (messages.length === 0) {
    res.status(400).json({ error: "messages must be a non-empty array" });
    return;
  }

  const model =
    typeof req.body?.model === "string" && req.body.model.length > 0
      ? req.body.model
      : undefined;

  const rawConversationId =
    typeof req.body?.conversationId === "string" &&
    req.body.conversationId.length > 0
      ? req.body.conversationId
      : undefined;
  const permissionMode = parseApprovalMode(req.body?.permissionMode);

  // Wire persistence only when DB is configured AND a conversationId was
  // supplied. Otherwise the agent loop runs stateless as before.
  let persistence: ReturnType<typeof safePersistence> | undefined;
  let conversationId = rawConversationId;
  let memory: ReturnType<typeof safeMemory> | undefined;

  /**
   * Pull a plain-text view out of a user message so persistence and memory
   * indexing keep working unchanged. Multimodal messages come in as
   * `ContentPart[]`; the joined text is the only thing the embedding model
   * and `autoTitle` consume. Originals are still persisted in the
   * `attachments` jsonb column.
   */
  const userMessageText = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter(
          (p): p is { type: "text"; text: string } =>
            typeof p === "object" && p !== null && (p as { type?: string }).type === "text",
        )
        .map((p) => p.text)
        .join("\n");
    }
    return "";
  };

  if (rawConversationId && isDbConfigured()) {
    memory = safeMemory({
      onMessageIndexed: async ({ conversationId, messageId, role, content }) => {
        await indexMessage({ conversationId, messageId, role, content });
      },
    });

    persistence = safePersistence({
      onUserMessage: async ({ conversationId, content }) => {
        await ensureConversation(conversationId);
        const text = userMessageText(content);
        const row = await appendMessage({
          conversationId,
          role: "user",
          content: text || null,
          attachments: Array.isArray(content) ? content : null,
        });
        if (memory && text) {
          void memory.onMessageIndexed({
            conversationId,
            messageId: row.id,
            role: "user",
            content: text,
          });
        }
      },
      onAssistantTurn: async ({ conversationId, content, toolCalls, usage }) => {
        const row = await appendMessage({
          conversationId,
          role: "assistant",
          content,
          toolCalls: toolCalls as unknown,
          usage,
        });
        if (memory && content) {
          void memory.onMessageIndexed({
            conversationId,
            messageId: row.id,
            role: "assistant",
            content,
          });
        }
      },
      onToolResult: async ({ conversationId, toolCallId, toolName, output }) => {
        await appendMessage({
          conversationId,
          role: "tool",
          content: output,
          toolCallId,
          toolName,
        });
        // Tool results aren't embedded -- they tend to be noisy and aren't
        // what users want surfaced as "memory" anyway.
      },
      onError: async ({ conversationId, message }) => {
        await setLastError(conversationId, message);
      },
    });
  } else {
    // Persist nothing; the agent loop sees `conversationId === undefined` and
    // skips every hook (the hooks are wrapped in `if (persistence && ...)`).
    conversationId = undefined;
  }

  // Build the recall block (top-k similar memories for the latest user
  // message). Capped at 5 hits; threshold keeps obvious noise out. Failure is
  // logged and the loop proceeds without recall.
  let recallBlock = "";
  if (isDbConfigured() && conversationId) {
    const lastUser = [...messages]
      .reverse()
      .find((m: { role: string }) => m.role === "user");
    if (lastUser) {
      // Accept both string and multimodal content (ContentPart[]). For the
      // latter we embed only the text parts — the embedding model is text-only.
      const query = (() => {
        if (typeof lastUser.content === "string") return lastUser.content;
        if (Array.isArray(lastUser.content)) {
          return (lastUser.content as unknown[])
            .filter(
              (p: unknown): p is { type: "text"; text: string } =>
                typeof p === "object" &&
                p !== null &&
                (p as { type?: string }).type === "text",
            )
            .map((p) => p.text)
            .join("\n");
        }
        return "";
      })();
      if (query.trim()) {
        try {
          const hits = await retrieveTopK(query, 5);
          recallBlock = buildRecallBlock(hits);
        } catch (err) {
          console.warn(
            "[memory] retrieveTopK failed (continuing without recall):",
            (err as Error).message,
          );
        }
      }
    }
  }

  // Inject today's date into the system context so the model can anchor
  // time-sensitive web searches (and reasoning) to the present, not its
  // training-data cutoff. Cheap (one system message per turn) and makes the
  // `mcp_minimax_web_search` results accurate without the user having to
  // call `get_current_time` first.
  const todayCtx = new Date().toISOString().slice(0, 10);
  const systemReminder =
    `Today's date is ${todayCtx} (UTC). ` +
    `When using web search or reasoning about time-sensitive topics, ` +
    `anchor your query or reasoning to this date so results reflect the present, ` +
    `not your training-data cutoff.`;

  try {
    await runAgent(
      {
        messages,
        model,
        conversationId,
        persistence,
        recallBlock,
        systemReminder,
        permissionMode,
      },
      res,
      abortController.signal,
    );
  } finally {
    responseFinished = true;
  }
});

/**
 * Resolve a pending tool approval. The agent loop registered a Promise with
 * `awaitApproval(id)` before sending the `approval_required` SSE event; this
 * endpoint resolves it when the user clicks Allow / Deny in the UI.
 *
 * No auth (single-tenant personal use). The id is a random UUID minted per
 * tool call; collisions and replay attacks are non-issues on a single machine.
 */
app.post("/api/chat/approval/:id", (req, res) => {
  const id = req.params.id;
  const decision = req.body?.decision;
  if (decision !== "allow" && decision !== "deny") {
    res.status(400).json({ ok: false, error: "decision must be 'allow' or 'deny'" });
    return;
  }
  const ok = resolveApproval(id, decision);
  if (!ok) {
    res.status(404).json({ ok: false, error: "unknown or expired approval id" });
    return;
  }
  res.json({ ok: true });
});

/* -------------------------------------------------------------------------- */
/* File uploads (MiniMax Files API proxy)                                      */
/* -------------------------------------------------------------------------- */

/**
 * Proxy a multipart file upload to the MiniMax Files API so the browser
 * doesn't need to ship the user's API key. The agent then references the
 * returned `file_id` in a `video_url` content part as `mm_file://{id}`.
 *
 * Currently only `purpose: "video_understanding"` is supported — that's
 * the only purpose that produces a multimodal file id. Images and small
 * videos (≤50 MB) should be sent as base64 `image_url` / `video_url` parts
 * from the client and don't need this endpoint.
 *
 * The server's `KeyRotator` picks a key (or env-var bootstrap), so the
 * endpoint transparently benefits from multi-key rotation.
 */
app.post("/api/uploads", uploadJson, async (req, res) => {
  // Increase the JSON body cap for the metadata part; the file itself is
  // streamed as multipart so it bypasses express.json's size limit.
  const cfg = getConfig();
  const baseUrl = cfg.baseUrl;

  // Minimal multipart parser: we accept `purpose` (string) and `file`
  // (the raw binary, base64-encoded so it survives JSON serialisation from
  // the client). This sidesteps busboy/multer and keeps the upload pipeline
  // simple at the cost of a ~33% size overhead on the wire.
  const body = (req.body ?? {}) as {
    purpose?: unknown;
    filename?: unknown;
    mime?: unknown;
    /** Base64-encoded file bytes. */
    data?: unknown;
  };
  const purpose = typeof body.purpose === "string" ? body.purpose : "";
  const filename = typeof body.filename === "string" ? body.filename : "upload.bin";
  const mime = typeof body.mime === "string" ? body.mime : "application/octet-stream";
  const dataB64 = typeof body.data === "string" ? body.data : "";

  if (purpose !== "video_understanding") {
    res.status(400).json({
      ok: false,
      error: "only `purpose: \"video_understanding\"` is supported",
    });
    return;
  }
  if (!dataB64) {
    res.status(400).json({ ok: false, error: "missing `data` (base64 file bytes)" });
    return;
  }

  // 512 MB cap mirrors the MiniMax Files API limit. The base64 envelope
  // expands size by ~4/3; the underlying binary maxes at ~384 MB after
  // decode. We pre-validate the encoded length to avoid blowing past
  // express.json's body cap.
  const MAX_ENCODED_BYTES = 512 * 1024 * 1024 * 1.4; // ~720 MB
  if (dataB64.length > MAX_ENCODED_BYTES) {
    res.status(413).json({
      ok: false,
      error: `file too large (encoded ${dataB64.length} > ${Math.round(MAX_ENCODED_BYTES)} bytes)`,
    });
    return;
  }

  const binary = Buffer.from(dataB64, "base64");

  // Build a multipart/form-data payload manually (Node 18+ has `undici`
  // FormData / Blob, but the global `fetch` doesn't ship with `FormData`
  // until Node 20; we use the global FormData/Blob from undici which the
  // server already pulls in transitively via `node-fetch`/the runtime).
  const form = new FormData();
  form.append("purpose", purpose);
  // `Blob` is provided by undici in modern Node; the `as any` cast keeps
  // TS happy across runtimes.
  form.append("file", new Blob([binary], { type: mime }), filename);

  const { getRotator } = await import("./keys/rotator.js");
  const rot = await getRotator(baseUrl);
  let upstream: Response;
  try {
    upstream = await rot.call(
      async (secret: string): Promise<Response> =>
        fetch(`${baseUrl}/files/upload`, {
          method: "POST",
          headers: { Authorization: `Bearer ${secret}` },
          body: form,
        }),
    );
  } catch (err) {
    const e = err as Error;
    res.status(502).json({ ok: false, error: `upload proxy failed: ${e.message}` });
    return;
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    res.status(upstream.status).json({
      ok: false,
      error: `MiniMax Files API ${upstream.status}: ${text || upstream.statusText}`,
    });
    return;
  }

  const json = (await upstream.json()) as {
    file?: { file_id?: number | string; bytes?: number; filename?: string };
    base_resp?: { status_code?: number; status_msg?: string };
  };
  const fileId = json.file?.file_id;
  if (fileId == null) {
    res.status(502).json({
      ok: false,
      error: "MiniMax response missing file_id",
      raw: json,
    });
    return;
  }

  res.json({
    ok: true,
    fileId: String(fileId),
    bytes: json.file?.bytes ?? binary.length,
    filename: json.file?.filename ?? filename,
    // Convenience: the content part the client should drop into the message.
    contentPart: {
      type: "video_url",
      video_url: { url: `mm_file://${fileId}` },
    },
  });
});

/**
 * Read-only sandbox endpoints powering the Workspace Explorer sidebar. Both
 * resolve paths through the same safe sandbox logic the agent tools use, so
 * a `..` traversal or absolute path returns 4xx.
 */

mountSandboxRouter(app);

const port = Number(process.env.PORT ?? 8787);

/**
 * Last-resort Express error handler. Catches anything the per-route handlers
 * miss — including a missing-DATABASE_URL throw from `getDb()` that would
 * otherwise crash the entire Node process. Returns 503 for the known
 * "database not configured" case so the UI can show a friendly error
 * instead of a hard ECONNREFUSED across all subsequent requests.
 */
app.use(
  (
    err: Error & { status?: number },
    _req: express.Request,
    res: express.Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _next: express.NextFunction,
  ) => {
    const message = err?.message ?? "Internal server error";
    if (message.includes("DATABASE_URL is not set")) {
      // eslint-disable-next-line no-console
      console.warn(
        "[api] request rejected — DATABASE_URL is not set:",
        message,
      );
      if (!res.headersSent) {
        res.status(503).json({ error: "database not configured" });
      }
      return;
    }
    // eslint-disable-next-line no-console
    console.error("[api] unhandled route error:", err);
    if (!res.headersSent) {
      res.status(err.status ?? 500).json({ error: message });
    }
  },
);

async function start(): Promise<void> {
  // Force eager init so the boot log shows which provider is active.
  getEmbeddings();
  // Boot the tool registry (native + MCP) before any request can hit.
  const toolStats = await initTools();
  console.log(
    `[tools] loaded ${toolStats.total} tools (${toolStats.native} native + ${toolStats.mcp} mcp)`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `[astryx-minimax-agent] backend listening on http://localhost:${port}`,
  );
  if (!process.env.MINIMAX_API_KEY && !isDbConfigured()) {
    // eslint-disable-next-line no-console
    console.warn(
      "[astryx-minimax-agent] No chat key configured — add one via Settings → Keys (or set MINIMAX_API_KEY in .env).",
    );
  } else if (!process.env.MINIMAX_API_KEY) {
    // eslint-disable-next-line no-console
    console.log(
      "[astryx-minimax-agent] MINIMAX_API_KEY not set — using DB-stored keys (Settings → Keys).",
    );
  } else {
    // Env-var key IS set; the keys/index.ts module will skip it if it
    // looks like the .env.example placeholder. Either way the DB-stored
    // keys (UI-managed) take precedence, and the env-var key joins the
    // pool as the synthetic "bootstrap" source.
    // eslint-disable-next-line no-console
    console.log(
      `[astryx-minimax-agent] MINIMAX_API_KEY is set (last 4: …${process.env.MINIMAX_API_KEY.slice(-4)}) — available as the bootstrap source. UI keys still take precedence.`,
    );
  }
  if (!isDbConfigured()) {
    // eslint-disable-next-line no-console
    console.warn(
      "[astryx-minimax-agent] DATABASE_URL is not set — conversation persistence is disabled (stateless mode). New /api/conversations endpoints return 503.",
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(
      "[astryx-minimax-agent] DATABASE_URL is set — conversation persistence is enabled.",
    );
  }
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[astryx-minimax-agent] server ready: http://localhost:${port}`,
    );
  });
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[astryx-minimax-agent] fatal startup error:", err);
  process.exit(1);
});

// Close MCP child processes on shutdown.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    stopScheduler();
    void shutdownTools().finally(() => process.exit(0));
  });
}

startScheduler();










