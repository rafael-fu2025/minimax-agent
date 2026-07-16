/**
 * Minimal Model Context Protocol (MCP) client.
 *
 * MCP uses JSON-RPC 2.0 over newline-delimited JSON. We support the **stdio**
 * transport: spawn a process, exchange framed messages on its stdin/stdout.
 *
 * Lifecycle:
 *   1. Spawn the configured process (command + args + optional env).
 *   2. Send `initialize` with our clientInfo + capabilities, await response.
 *   3. Send the `initialized` notification (no response expected).
 *   4. Send `tools/list`, await response. Cache the list of MCP tool defs.
 *   5. From here, the server is ready. `callTool(name, args)` sends
 *      `tools/call` and returns the result.
 *
 * API key plumbing: each spawned MCP process receives its env at spawn time.
 * For servers that need the active MiniMax API key, set `cfg.keyRef = "db"`:
 *   - The MCP process is launched with `MINIMAX_API_KEY` set to the most
 *     recently-used active DB row's secret.
 *   - When the keys pool changes (add/update/delete) the boot module calls
 *     `restartAllMcpServers()` to kill the old process and respawn with the
 *     freshest key — no need to bounce the whole server.
 *
 * Errors:
 *   - spawn / initialize failures throw; `bootMcpServers` catches per-server
 *     so one bad config doesn't take down the rest.
 *   - per-request errors (tool not found, server crash mid-call) are surfaced
 *     as a string in the tool result so the model can read them.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * When "db", the server's MINIMAX_API_KEY env var is auto-populated
   * with the secret of the first active row in the  table
   * (looked up at boot). Lets the MCP authenticate without a key in
   * MCP_SERVERS itself. Overrides any value the JSON might also specify
   * for that var. Falls back silently if no active row exists.
   */
  keyRef?: "db";
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const PROTOCOL_VERSION = "2024-11-05";
const CLIENT_INFO = { name: "astryx-minimax-agent", version: "0.1.0" };

/**
 * Per-request timeout. Without this, a wedged MCP server would hang the
 * agent loop indefinitely (the JSON-RPC Promise never resolves, the agent
 * never advances to its next turn, and the chat becomes unresponsive).
 * 60s is generous — MCP tools typically complete in milliseconds — while
 * still bounding the worst case. Overridable for tests.
 */
const MCP_REQUEST_TIMEOUT_MS = Number(process.env.MCP_REQUEST_TIMEOUT_MS ?? 60_000);

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

export class McpClient {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = "";
  private pending = new Map<number, (resp: JsonRpcResponse) => void>();
  private nextId = 1;
  private serverInfo: { name: string; version: string } | null = null;
  private tools: McpToolDef[] = [];
  private cfg: McpServerConfig;
  private closed = false;

  private constructor(proc: ChildProcessWithoutNullStreams, cfg: McpServerConfig) {
    this.proc = proc;
    this.cfg = cfg;
  }

  static async connect(cfg: McpServerConfig): Promise<McpClient> {
    const proc = spawn(cfg.command, cfg.args ?? [], {
      env: { ...process.env, ...(cfg.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;

    const client = new McpClient(proc, cfg);

    proc.stdout.on("data", (chunk: Buffer) => client.onStdout(chunk));
    proc.stderr.on("data", (chunk: Buffer) => {
      // Surface MCP server stderr as a warning; not fatal.
      const text = chunk.toString("utf8").trim();
      if (text) {
        console.warn(`[mcp:${cfg.name}] stderr: ${text}`);
      }
    });
    proc.on("close", (code, signal) => {
      client.closed = true;
      const err: JsonRpcResponse = {
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: `MCP server ${cfg.name} exited (code=${code}, signal=${signal})`,
        },
      };
      for (const [id, cb] of client.pending) {
        cb(err);
        client.pending.delete(id);
      }
    });
    proc.on("error", (err) => {
      client.closed = true;
      const e: JsonRpcResponse = {
        jsonrpc: "2.0",
        error: { code: -32000, message: `MCP server ${cfg.name} spawn error: ${err.message}` },
      };
      for (const [id, cb] of client.pending) {
        cb(e);
        client.pending.delete(id);
      }
    });

    // 1) initialize
    const initResp = await client.request<{
      serverInfo: { name: string; version: string };
      capabilities: unknown;
    }>("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    client.serverInfo = initResp.serverInfo;
    // 2) initialized notification (no id, no response expected)
    client.notify("notifications/initialized", {});

    // 3) tools/list
    const toolsResp = await client.request<{ tools: McpToolDef[] }>("tools/list", {});
    client.tools = (toolsResp.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
    }));

    return client;
  }

  listTools(): McpToolDef[] {
    return this.tools;
  }

  serverName(): string {
    return this.cfg.name;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (this.closed) {
      return `Error: MCP server ${this.cfg.name} is closed`;
    }
    try {
      const resp = await this.request<{
        content?: Array<{ type: string; text?: string; data?: string }>;
        isError?: boolean;
      }>("tools/call", { name, arguments: args ?? {} }, MCP_REQUEST_TIMEOUT_MS);
      if (resp.isError) {
        const texts = (resp.content ?? [])
          .filter((c) => c.type === "text" && typeof c.text === "string")
          .map((c) => c.text!)
          .join("\n");
        return `Error from MCP tool ${name}: ${texts || "unknown error"}`;
      }
      const texts = (resp.content ?? [])
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text!);
      return texts.length > 0 ? texts.join("\n") : JSON.stringify(resp.content);
    } catch (err) {
      return `Error calling MCP tool ${name}: ${(err as Error).message}`;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.proc.kill("SIGTERM");
    } catch {
      // ignore
    }
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                          */
  /* ------------------------------------------------------------------ */

  private request<T>(method: string, params?: unknown, timeoutMs: number = MCP_REQUEST_TIMEOUT_MS): Promise<T> {
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(id);
        fn();
      };
      this.pending.set(id, (resp) => {
        settle(() => {
          if (resp.error) {
            reject(new Error(`${resp.error.message} (code=${resp.error.code})`));
          } else {
            resolve(resp.result as T);
          }
        });
      });
      const timer = setTimeout(() => {
        settle(() =>
          reject(
            new Error(
              `MCP request ${method} (id=${id}) timed out after ${timeoutMs}ms`,
            ),
          ),
        );
      }, timeoutMs);
      this.send(req);
    });
  }

  private notify(method: string, params?: unknown): void {
    // JSON-RPC notifications omit the `id` field entirely. Sending `id: 0`
    // is technically a request (some servers validate it as PingRequest).
    const frame: JsonRpcRequest = { jsonrpc: "2.0", method, params };
    this.send(frame);
  }

  private send(req: JsonRpcRequest): void {
    if (this.closed) return;
    try {
      this.proc.stdin.write(JSON.stringify(req) + "\n", "utf8");
    } catch (err) {
      // E.g. broken pipe; treat as a transport error. The 'close' handler
      // will reject any pending requests.
      console.warn(`[mcp:${this.cfg.name}] send failed:`, (err as Error).message);
    }
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let parsed: JsonRpcResponse;
      try {
        parsed = JSON.parse(line) as JsonRpcResponse;
      } catch {
        // Ignore non-JSON lines (some servers log to stdout).
        continue;
      }
      if (typeof parsed.id !== "number" || parsed.id === 0) {
        // Notification (no id, or our own notification id 0). Drop.
        continue;
      }
      const cb = this.pending.get(parsed.id);
      if (!cb) continue;
      this.pending.delete(parsed.id);
      cb(parsed);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Boot helper                                                                */
/* -------------------------------------------------------------------------- */

export interface BootedMcp {
  clients: McpClient[];
  toolDefs: Array<{ server: string; tool: McpToolDef }>;
}

/**
 * Pick a DB-stored API key for an MCP server that has `keyRef: "db"`.
 *
 * Order of preference:
 *   1. The most recently-used active DB key (mirrors the rotator's
 *      round-robin behavior — using a recently-used key avoids picking
 *      a brand-new one that the upstream provider might still be
 *      provisioning).
 *   2. Any active DB key.
 *   3. The .env bootstrap key (already vetted by the rotator).
 *   4. `null` if nothing is available; the caller logs and skips.
 *
 * Reuses `loadSources` so we don't duplicate the boot/placeholder/DB
 * plumbing — it always reflects the current state of the keys pool.
 */
async function pickDbKeyForMcp(): Promise<string | null> {
  // We import lazily so this module stays usable when the DB is disabled
  // (e.g. unit tests that mock the client without a live database).
  try {
    const { loadSources } = await import("../keys/index.js");
    const sources = await loadSources("https://api.minimax.io/v1");
    // Prefer an active DB row over the bootstrap, but fall back to the
    // bootstrap if there are no DB rows yet.
    const dbRow = sources.find((s) => !s.isBootstrap && s.row?.status === "active");
    if (dbRow) return dbRow.secret;
    const anyActive = sources.find((s) => s.row?.status !== "disabled");
    if (anyActive) return anyActive.secret;
    // No DB rows; pick the bootstrap env-var key.
    const bootstrap = sources.find((s) => s.isBootstrap);
    return bootstrap?.secret ?? null;
  } catch (err) {
    console.warn("[mcp] pickDbKeyForMcp failed:", (err as Error).message);
    return null;
  }
}

/**
 * Live set of booted MCP clients keyed by server name. Used by
 * `restartAllMcpServers()` to kill and respawn them when the keys pool
 * changes (so an MCP that depends on the DB key uses the freshest one).
 */
const bootedClients: McpClient[] = [];

export function getBootedMcpClients(): readonly McpClient[] {
  return bootedClients;
}

export async function bootMcpServers(envValue: string | undefined): Promise<BootedMcp> {
  const out: BootedMcp = { clients: [], toolDefs: [] };
  if (!envValue) return out;
  // Resolve the live keys pool once at boot, then refresh whenever keys change.
  const dbKey = await pickDbKeyForMcp();
  let cfgs: McpServerConfig[];
  try {
    cfgs = JSON.parse(envValue);
  } catch (err) {
    console.warn("[mcp] MCP_SERVERS is not valid JSON; ignoring:", (err as Error).message);
    return out;
  }
  if (!Array.isArray(cfgs)) {
    console.warn("[mcp] MCP_SERVERS must be a JSON array; ignoring.");
    return out;
  }
  if (dbKey) {
    for (const cfg of cfgs) {
      if (cfg.keyRef === "db") {
        cfg.env = { ...(cfg.env ?? {}), MINIMAX_API_KEY: dbKey };
      }
    }
  } else {
    for (const cfg of cfgs) {
      if (cfg.keyRef === "db") {
        console.warn('[mcp] ' + cfg.name + ' keyRef=db but no active keys');
      }
    }
  }
  await spawnConfiguredServers(cfgs, out);
  return out;
}

/**
 * Re-spawn every running MCP server with a fresh DB key (if any). Called
 * from the keys module after `addKey` / `updateKey` / `deleteKey` so the
 * MCP always sees the most recently-used active key without restarting
 * the whole agent.
 *
 * Safe to call when no MCPs are running — it's a no-op.
 *
 * The actual registry mutation (`tools.push(...)`, `toolMap = ...`,
 * `toolSchemas = ...`) lives in `tools.ts` because the array is owned
 * there. We accept an `onReloaded` callback so the caller can re-register
 * the fresh tool definitions exactly as `initTools()` does on cold start.
 */
export async function restartAllMcpServers(
  envValue: string | undefined,
  onReloaded?: (booted: BootedMcp) => Promise<void> | void,
): Promise<void> {
  if (!envValue) return;
  let cfgs: McpServerConfig[];
  try {
    cfgs = JSON.parse(envValue);
  } catch {
    return;
  }
  if (!Array.isArray(cfgs)) return;
  // Stop currently-running clients before respawning so the stdio
  // subprocess actually releases its env / sockets.
  for (const c of bootedClients.splice(0, bootedClients.length)) {
    try {
      await c.close();
    } catch {
      // ignore
    }
  }
  const dbKey = await pickDbKeyForMcp();
  if (dbKey) {
    for (const cfg of cfgs) {
      if (cfg.keyRef === "db") {
        cfg.env = { ...(cfg.env ?? {}), MINIMAX_API_KEY: dbKey };
      }
    }
  }
  const out: BootedMcp = { clients: [], toolDefs: [] };
  await spawnConfiguredServers(cfgs, out);
  if (onReloaded) await onReloaded(out);
}

/**
 * Shared spawn loop used by both `bootMcpServers` (cold start) and
 * `restartAllMcpServers` (hot reload). On success, each client's tools are
 * pushed onto the live `tools` array so the agent can call them.
 */
async function spawnConfiguredServers(
  cfgs: McpServerConfig[],
  out: BootedMcp,
): Promise<void> {
  for (const cfg of cfgs) {
    if (!cfg.name || !cfg.command) {
      console.warn("[mcp] skipping server with missing name/command:", cfg);
      continue;
    }
    try {
      const client = await McpClient.connect(cfg);
      out.clients.push(client);
      bootedClients.push(client);
      for (const tool of client.listTools()) {
        out.toolDefs.push({ server: cfg.name, tool });
      }
      console.log(
        `[mcp] connected to ${cfg.name} (${client.listTools().length} tools)`,
      );
    } catch (err) {
      console.warn(
        `[mcp] failed to start ${cfg.name}:`,
        (err as Error).message,
      );
    }
  }
}




