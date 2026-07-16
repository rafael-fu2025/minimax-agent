/**
 * Tool definitions and executors for the agent.
 *
 * Architecture:
 *   - Native tools live in this module (time, calculate, web_search) and in
 *     ./tools/{fs,exec}.ts. They are statically registered at module load.
 *   - At server boot, `initTools()` connects to any MCP servers listed in
 *     `MCP_SERVERS` and merges their tools into the live `tools` array,
 *     namespaced as `mcp_<server>_<tool>`.
 *   - `toolMap` and `toolSchemas` are `let` exports; we re-assign them after
 *     the MCP merge so any importer using the live ESM binding sees the
 *     final set. `runTool` looks up the latest `tools` on every call.
 *
 * Keep tools small, safe, and side-effect aware.
 */

import { fsTools } from "./tools/fs.js";
import { execTools } from "./tools/exec.js";
import { fileOpsTools } from "./tools/file-ops.js";
import { searchTools } from "./tools/search.js";
import { systemTools } from "./tools/system.js";
import { webTools } from "./tools/web.js";
import { gitTools } from "./tools/git.js";
import { archiveTools } from "./tools/archive.js";
import { pdfTools } from "./tools/pdf.js";
import { formatTools } from "./tools/format.js";
import { audioTools } from "./tools/audio.js";
import { imageTools } from "./tools/image.js";
import { pythonTools } from "./tools/python.js";
import { schedulerTools } from "./tools/scheduler.js";
import {
  bootMcpServers,
  restartAllMcpServers,
  type McpClient,
} from "./tools/mcp.js";
import { getSandboxRoot } from "./tools/sandbox.js";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ToolApprovalMode } from "./tools/approval.js";

export type ToolExecutor = (
  args: Record<string, unknown>,
  ctx?: { permissionMode?: ToolApprovalMode },
) => Promise<string>;

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's parameters (OpenAI function-calling format). */
  parameters: Record<string, unknown>;
  execute: ToolExecutor;
  /**
   * Provenance for the `/api/tools` snapshot. `undefined` means a native
   * tool; an MCP server records its stable name (`server`) so the
   * `/api/tools` endpoint doesn't have to *parse* the namespaced tool name
   * (which breaks when an MCP server name contains underscores).
   */
  source?: string;
  /**
   * Optional human-readable one-line preview of the tool call, shown in
   * the approval dialog. Tools should attach their own formatter so the
   * approval pipeline doesn't need a giant per-tool if/else chain. When
   * `undefined`, the caller falls back to a JSON.stringify of the args.
   */
  preview?: (args: Record<string, unknown>) => string;
}

/* -------------------------------------------------------------------------- */
/* Individual tool implementations                                            */
/* -------------------------------------------------------------------------- */

const getCurrentTime: ToolDefinition = {
  name: "get_current_time",
  description:
    "Returns the current local date and time, optionally formatted with a strftime-style pattern. Use when the user asks about the current time, today's date, or anything time-sensitive.",
  parameters: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description:
          "IANA timezone name, e.g. 'Asia/Manila'. Defaults to the server's local timezone.",
      },
      format: {
        type: "string",
        description: "Optional format pattern. Defaults to a human-readable string.",
      },
    },
    additionalProperties: false,
  },
  execute: async (args) => {
    const timezone =
      typeof args.timezone === "string" ? args.timezone : undefined;
    const format = typeof args.format === "string" ? args.format : undefined;
    try {
      const now = new Date();
      const options: Intl.DateTimeFormatOptions = {
        timeZone: timezone,
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
      };
      const human = new Intl.DateTimeFormat("en-US", options).format(now);
      const iso = now.toISOString();
      return format
        ? `Formatted (${format}): ${human} (ISO: ${iso})`
        : `Current time: ${human} (ISO: ${iso})`;
    } catch (err) {
      return `Error reading time: ${(err as Error).message}`;
    }
  },
};

const calculate: ToolDefinition = {
  name: "calculate",
  description:
    "Evaluates a mathematical expression and returns the numeric result. Supports +, -, *, /, **, parentheses, Math.* functions, and common constants. Use for arithmetic the model is unsure about.",
  parameters: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description: "A safe arithmetic expression, e.g. '(2 + 3) * 4' or 'Math.sqrt(144)'.",
      },
    },
    required: ["expression"],
    additionalProperties: false,
  },
  execute: async (args) => {
    const expression = String(args.expression ?? "");
    // Only allow a strict whitelist of characters to keep this safe.
    if (!/^[0-9+\-*/().,\sMath_a-zA-Z]*$/.test(expression)) {
      return "Error: expression contains disallowed characters.";
    }
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function("Math", `"use strict"; return (${expression});`);
      const result = fn(Math);
      if (typeof result !== "number" || !Number.isFinite(result)) {
        return `Error: expression did not evaluate to a finite number (got ${String(result)}).`;
      }
      return `Result: ${result}`;
    } catch (err) {
      return `Error evaluating expression: ${(err as Error).message}`;
    }
  },
};

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

const NATIVE_TOOLS: ToolDefinition[] = [
  getCurrentTime,
  calculate,
  ...fsTools,
  ...execTools,
  ...fileOpsTools,
  ...searchTools,
  ...systemTools,
  ...webTools,
  ...gitTools,
  ...archiveTools,
  ...pdfTools,
  ...formatTools,
  ...audioTools,
  ...imageTools,
  ...pythonTools,
  ...schedulerTools,
];

// Mutable so initTools() can append MCP tools; live ESM bindings keep the
// import in `server/agent.ts` in sync.
export let tools: ToolDefinition[] = [...NATIVE_TOOLS];

export let toolMap: Record<string, ToolDefinition> = Object.fromEntries(
  tools.map((t) => [t.name, t]),
);

/** OpenAI-compatible tool schemas (sent to the model). */
export let toolSchemas = tools.map((t) => ({
  type: "function" as const,
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

let mcpClients: McpClient[] = [];

export async function initTools(): Promise<{
  total: number;
  native: number;
  mcp: number;
}> {
  // Previously this early-returned when `mcpClients.length > 0`, which
  // made the duplicate-name detection below dead code on hot paths
  // (every subsequent call returned before reaching the merge loop).
  // Now we always re-run the merge: the boot step is idempotent on a
  // fresh `booted` client set, and re-running the merge is what
  // `reloadMcpTools()` actually needs when called with a fresh key.
  const booted = await bootMcpServers(process.env.MCP_SERVERS);
  // Close any prior MCP clients we still hold — bootMcpServers returns
  // a fresh set, and leaving the old ones open would leak stdio
  // subprocesses. `reloadMcpTools()` already handles this; we mirror it
  // here so initTools() is safe to call repeatedly.
  for (const c of mcpClients) {
    try {
      await c.close();
    } catch {
      // ignore
    }
  }
  mcpClients = booted.clients;
  for (const { server, tool } of booted.toolDefs) {
    const client = booted.clients.find((c) => c.serverName() === server);
    if (!client) continue;
    const def: ToolDefinition = {
      name: `mcp_${server}_${tool.name}`,
      description: tool.description
        ? `[MCP ${server}] ${tool.description}`
        : `[MCP ${server}] ${tool.name}`,
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
      source: server, // the stable MCP server name; surfaced via /api/tools
      execute: async (args) => {
        return await client.callTool(tool.name, args);
      },
    };
    // Skip if a native tool with the same name was registered first.
    if (tools.some((t) => t.name === def.name)) {
      console.warn(`[tools] skipping duplicate tool name: ${def.name}`);
      continue;
    }
    tools.push(def);
  }
  // Re-derive the map and schemas so the live bindings pick up the new tools.
  toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));
  toolSchemas = tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  return {
    total: tools.length,
    native: NATIVE_TOOLS.length,
    mcp: tools.length - NATIVE_TOOLS.length,
  };
}

export async function shutdownTools(): Promise<void> {
  for (const c of mcpClients) {
    try {
      await c.close();
    } catch {
      // ignore
    }
  }
  mcpClients = [];
}

/**
 * Hot-reload the MCP server processes. Used after a key add / update /
 * delete so any MCP server that declared `keyRef: "db"` is respawned
 * with the freshest DB key — no agent restart required.
 *
 * Mirrors the registration logic in `initTools()`:
 *   1. Boot the MCP servers (their env is rewritten to the new key).
 *   2. Drop every prior MCP-derived tool from the registry.
 *   3. Re-add each newly-discovered tool with the matching client.
 *   4. Rebuild `toolMap` + `toolSchemas` for the live bindings.
 */
export async function reloadMcpTools(): Promise<void> {
  const envValue = process.env.MCP_SERVERS;

  // Track which `tools[]` entries were MCP-derived (had `isMcp === true`)
  // so we can remove only those and keep all native tools intact.
  const mcpEntryCount = tools.length - NATIVE_TOOLS.length;
  if (mcpEntryCount > 0) {
    tools.splice(NATIVE_TOOLS.length, mcpEntryCount);
  }

  // Close any live MCP clients; the MCP module owns their lifecycle.
  for (const c of mcpClients) {
    try {
      await c.close();
    } catch {
      // ignore
    }
  }
  mcpClients = [];

  if (!envValue) {
    // MCPs disabled — re-derive schema/map from whatever's left (native only).
    toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));
    toolSchemas = tools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    return;
  }

  // Re-boot with the new key, then re-attach the new clients to the registry.
  await restartAllMcpServers(envValue, async (booted) => {
    mcpClients = booted.clients;
    for (const { server, tool } of booted.toolDefs) {
      const client = booted.clients.find((c) => c.serverName() === server);
      if (!client) continue;
      const def: ToolDefinition = {
        name: `mcp_${server}_${tool.name}`,
        description: tool.description
          ? `[MCP ${server}] ${tool.description}`
          : `[MCP ${server}] ${tool.name}`,
        parameters: tool.inputSchema ?? { type: "object", properties: {} },
        source: server,
        execute: async (args) => {
          return await client.callTool(tool.name, args);
        },
      };
      if (tools.some((t) => t.name === def.name)) {
        console.warn(`[tools] skipping duplicate tool name: ${def.name}`);
        continue;
      }
      tools.push(def);
    }
    toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));
    toolSchemas = tools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  });
}

export async function runTool(
  name: string,
  rawArgs: string,
  ctx?: {
    permissionMode?: ToolApprovalMode;
    /**
     * The most recent user message's `content` (or parts array). Tools that
     * expect a file path on disk (e.g. `mcp_minimax_understand_image`) can
     * use this to materialize inline `image_url` / `video_url` content parts
     * to sandbox files when the model passes a placeholder path.
     */
    lastUserContent?: unknown;
  },
): Promise<string> {
  // Always look up the latest `tools` array so newly-merged MCP tools resolve.
  const tool = tools.find((t) => t.name === name);
  if (!tool) return `Error: unknown tool "${name}".`;
  let parsed: Record<string, unknown> = {};
  if (rawArgs && rawArgs.trim().length > 0) {
    try {
      parsed = JSON.parse(rawArgs);
    } catch (err) {
      return `Error: tool arguments were not valid JSON (${(err as Error).message}). Raw: ${rawArgs}`;
    }
  }
  try {
    // If the tool is an MCP image-understanding call, rewrite placeholder
    // paths to a real sandbox file materialized from the most recent inline
    // image. The MCP upstream expects a path on disk; the model frequently
    // passes a placeholder like "user_image" because it doesn't know where
    // the inline image is stored.
    if (name.startsWith("mcp_") && name.endsWith("_understand_image")) {
      const rewritten = await materializeInlineImage(parsed, ctx?.lastUserContent);
      if (rewritten) parsed = rewritten;
    }
    return await tool.execute(parsed, ctx);
  } catch (err) {
    return `Error executing ${name}: ${(err as Error).message}`;
  }
}

/* -------------------------------------------------------------------------- */
/* Inline-image materialization                                                */
/* -------------------------------------------------------------------------- */

/**
 * When the model calls an MCP image-understanding tool with a path-like
 * argument that doesn't exist on disk (e.g. `"user_image"`, `"<inline>"`,
 * `""`, or any path that realpath can't resolve), look at the most recent
 * user message's content for an `image_url` content part and write its
 * base64 data to `images/inline-<timestamp>.<ext>` inside the sandbox. Then
 * rewrite the placeholder argument to the real path.
 *
 * Returns the rewritten args object, or `null` if no rewrite was performed
 * (in which case the tool runs with its original args).
 */
async function materializeInlineImage(
  args: Record<string, unknown>,
  lastUserContent: unknown,
): Promise<Record<string, unknown> | null> {
  // 1. Decide whether the current args contain a "bad" path that needs
  //    rewriting. We look at every string-typed arg that's clearly a path
  //    (`file_path`, `image_path`, `path`, `image`, `url`) and check if it
  //    either points at a placeholder string OR doesn't resolve on disk.
  const PATH_KEYS = ["file_path", "image_path", "path", "image", "url"];
  const pathKey = PATH_KEYS.find((k) => typeof args[k] === "string");
  if (!pathKey) return null;

  const candidate = String(args[pathKey]);
  // Stricter placeholder match: the *basename* (last path segment) must be
  // one of the well-known placeholder tokens. Substring matching previously
  // rewrote paths like `assets/inline-icon.svg` because they contained
  // "inline" anywhere.
  const basename = candidate.split(/[\\/]/).pop() ?? "";
  const isPlaceholder =
    candidate.trim() === "" ||
    /^(user[_-]?image|inline|uploaded|attachment)$/i.test(basename);

  // If the caller passed what looks like a real, on-disk path, stat it.
  // When it exists, the user is doing the right thing and we shouldn't
  // shadow their input. When it doesn't, we still don't rewrite — let the
  // tool surface its own error rather than silently substituting.
  if (!isPlaceholder) {
    let exists = false;
    try {
      const { stat } = await import("node:fs/promises");
      await stat(candidate);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) return null;
    // Non-placeholder path that doesn't exist: fall through to no-op so the
    // tool errors as before. We only rewrite placeholder-looking strings.
    return null;
  }

  // 2. Find an inline image in the most recent user message.
  const inline = findInlineImage(lastUserContent);
  if (!inline) return null;

  // 3. Decode the data URL.
  const match = inline.dataUrl.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
  if (!match) return null;
  const mime = (match[1] || "image/png").toLowerCase();
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || "";
  const bytes = isBase64
    ? Buffer.from(payload, "base64")
    : Buffer.from(decodeURIComponent(payload), "utf8");

  // Cap inline images at 50 MB. The MCP image-understanding endpoint only
  // accepts images up to ~10 MB anyway; refusing here protects the sandbox
  // from accidental or malicious huge payloads.
  const MAX_INLINE_IMAGE_BYTES = 50 * 1024 * 1024;
  if (bytes.length > MAX_INLINE_IMAGE_BYTES) {
    return null;
  }

  // 4. Pick a filename based on mime type.
  const ext = mimeExtFor(mime);
  const filename = `inline-${Date.now()}.${ext}`;

  // 5. Write into <sandbox>/images/<filename>.
  const root = getSandboxRoot();
  const dir = join(root, "images");
  await mkdir(dir, { recursive: true });
  const fullPath = join(dir, filename);
  await writeFile(fullPath, bytes);

  // 6. Return the rewritten args with a path the MCP can read. The MCP
  //    tool expects a path string; the upstream MiniMax image-understanding
  //    tool accepts both absolute and sandbox-relative paths.
  const rewritten = { ...args, [pathKey]: fullPath };
  return rewritten;
}

/** Pull the first `image_url` data URL out of a user message's content. */
function findInlineImage(
  content: unknown,
): { dataUrl: string; mime: string } | null {
  if (content == null) return null;
  // Text-only message.
  if (typeof content === "string") return null;
  // Array of content parts.
  if (Array.isArray(content)) {
    for (const part of content) {
      if (
        part &&
        typeof part === "object" &&
        (part as { type?: string }).type === "image_url"
      ) {
        const url = (part as { image_url?: { url?: string } }).image_url?.url;
        if (typeof url === "string" && url.startsWith("data:")) {
          return { dataUrl: url, mime: "image" };
        }
      }
    }
  }
  return null;
}

function mimeExtFor(mime: string): string {
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("png")) return "png";
  if (mime.includes("gif")) return "gif";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("bmp")) return "bmp";
  return "bin";
}


