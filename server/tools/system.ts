/**
 * System-info tools: list running processes, kill a process by PID, read
 * environment variables. Process listing is cross-platform (tasklist on
 * Windows, ps on POSIX). Killing is gated by a PID safety check (refuse
 * PID 0 / 1 / the server's own PID).
 */

import { spawn } from "node:child_process";
import { resolveSafePath } from "./sandbox.js";
import type { ToolDefinition } from "../tools.js";

const IS_WIN = process.platform === "win32";
const SERVER_PID = process.pid;

/* -------------------------------------------------------------------------- */
/* list_processes                                                             */
/* -------------------------------------------------------------------------- */

async function listProcesses(): Promise<Array<{ pid: number; command: string }>> {
  return new Promise((resolve) => {
    if (IS_WIN) {
      // /FO CSV gives parseable output; /NH omits the header row.
      const child = spawn("tasklist", ["/FO", "CSV", "/NH"], { windowsHide: true });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => (out += c.toString("utf8")));
      child.stderr.on("data", (c) => (err += c.toString("utf8")));
      child.on("close", () => {
        // Lines look like: "node.exe","1234","Console","1","12,345 K"
        const rows: Array<{ pid: number; command: string }> = [];
        for (const line of out.split(/\r?\n/)) {
          if (!line.trim()) continue;
          const cols = line.split(/","/).map((c) => c.replace(/^"|"$/g, ""));
          const command = cols[0];
          const pid = Number(cols[1]);
          if (command && Number.isFinite(pid)) rows.push({ pid, command });
        }
        resolve(rows);
      });
      child.on("error", () => resolve([]));
    } else {
      const child = spawn("ps", ["-eo", "pid=,comm=,args="], {});
      let out = "";
      child.stdout.on("data", (c) => (out += c.toString("utf8")));
      child.on("close", () => {
        const rows: Array<{ pid: number; command: string }> = [];
        for (const line of out.split("\n")) {
          if (!line.trim()) continue;
          const firstSpace = line.indexOf(" ");
          if (firstSpace < 0) continue;
          const pid = Number(line.slice(0, firstSpace));
          const rest = line.slice(firstSpace + 1).trim();
          if (Number.isFinite(pid) && rest) rows.push({ pid, command: rest });
        }
        resolve(rows);
      });
      child.on("error", () => resolve([]));
    }
  });
}

const listProcessesTool: ToolDefinition = {
  name: "list_processes",
  description:
    "List currently running processes with PID and command. Cross-platform: `tasklist` on Windows, `ps -eo pid,comm,args` on Linux/macOS. Returns JSON array of `{pid, command}`. Read-only — no approval needed in any mode.",
  parameters: {
    type: "object",
    properties: {
      max_results: {
        type: "number",
        description: "Cap on returned processes. Default 200.",
      },
      filter: {
        type: "string",
        description: "Substring filter against the command (case-insensitive).",
      },
    },
    additionalProperties: false,
  },
  preview: (args) =>
    typeof args.filter === "string" ? `ps aux | grep ${args.filter}` : "ps aux",
  execute: async (args) => {
    try {
      const max = Math.min(Math.max(Number(args.max_results ?? 200), 1), 2000);
      const filter = String(args.filter ?? "").toLowerCase();
      const all = await listProcesses();
      const filtered = filter
        ? all.filter((p) => p.command.toLowerCase().includes(filter))
        : all;
      const trimmed = filtered.slice(0, max);
      const lines = trimmed.map((p) => JSON.stringify(p));
      if (filtered.length > max) {
        return `[${lines.join(",")}]\n[truncated at ${max}; total: ${filtered.length}]`;
      }
      return `[${lines.join(",")}]`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

/* -------------------------------------------------------------------------- */
/* kill_process                                                                */
/* -------------------------------------------------------------------------- */

const killProcessTool: ToolDefinition = {
  name: "kill_process",
  description:
    "Kill a process by PID. Cross-platform: `taskkill /F /PID` on Windows, `kill -9` on POSIX. Refuses to kill PID 0, PID 1, or the server's own PID — only kill processes you actually want to stop.",
  parameters: {
    type: "object",
    properties: {
      pid: { type: "number", description: "Process ID to terminate." },
    },
    required: ["pid"],
    additionalProperties: false,
  },
  preview: (args) =>
    `kill ${typeof args.pid === "number" ? String(args.pid) : "?"}`,
  execute: async (args) => {
    try {
      const pid = Number(args.pid);
      if (!Number.isFinite(pid) || pid <= 1) {
        return `Error: refusing to kill reserved PID ${pid}`;
      }
      if (pid === SERVER_PID) {
        return `Error: refusing to kill the server's own PID (${pid})`;
      }
      if (IS_WIN) {
        await new Promise<void>((resolve, reject) => {
          const child = spawn("taskkill", ["/F", "/PID", String(pid)], { windowsHide: true });
          let out = "";
          let err = "";
          child.stdout.on("data", (c) => (out += c.toString("utf8")));
          child.stderr.on("data", (c) => (err += c.toString("utf8")));
          child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err || out || `exit ${code}`))));
          child.on("error", reject);
        });
      } else {
        process.kill(pid, "SIGKILL");
      }
      return `Killed PID ${pid}`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

/* -------------------------------------------------------------------------- */
/* env_get                                                                     */
/* -------------------------------------------------------------------------- */

const SENSITIVE_HINTS = /(key|token|secret|password|passwd|cred|auth)/i;

const envGetTool: ToolDefinition = {
  name: "env_get",
  description:
    "Read a single environment variable by name, or list all variables. Variables whose names match `/key|token|secret|password|passwd|cred|auth/i` are redacted as `***`. The server inherits `process.env` at startup — values added at runtime via `set -x` are NOT visible here. Read-only.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Variable name to look up. Omit to list all variables (with redaction).",
      },
    },
    additionalProperties: false,
  },
  preview: (args) =>
    typeof args.name === "string" ? `echo $${args.name}` : "env",
  execute: async (args) => {
    try {
      if (args.name !== undefined) {
        const name = String(args.name);
        const v = process.env[name];
        if (v === undefined) return `(undefined: ${name})`;
        const display = SENSITIVE_HINTS.test(name) ? "***" : v;
        return `${name}=${display}`;
      }
      const out: string[] = [];
      const names = Object.keys(process.env).sort();
      for (const name of names) {
        const v = process.env[name];
        if (v === undefined) continue;
        const display = SENSITIVE_HINTS.test(name) ? "***" : v;
        out.push(`${name}=${display}`);
      }
      return out.join("\n");
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

void resolveSafePath; // (re-exported from sandbox for type symmetry)
export const systemTools: ToolDefinition[] = [
  listProcessesTool,
  killProcessTool,
  envGetTool,
];
