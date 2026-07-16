/**
 * `format_code` — run a code-formatter on a file. Spawns `prettier` (default)
 * or `black` (Python) or a custom command. If the tool isn't installed,
 * returns a friendly error rather than failing silently.
 */

import { spawn } from "node:child_process";
import { stat, readFile, writeFile } from "node:fs/promises";
import { resolveSafePath } from "./sandbox.js";
import type { ToolDefinition } from "../tools.js";

const TIMEOUT_MS = 30_000;

interface FormatterSpec {
  cmd: string;
  buildArgs: (file: string) => string[];
  inPlace: boolean;
}

const FORMATTERS: Record<string, FormatterSpec> = {
  prettier: {
    cmd: "npx",
    buildArgs: (file) => ["--no-install", "prettier", "--write", file],
    inPlace: true,
  },
  black: {
    cmd: "black",
    buildArgs: (file) => [file],
    inPlace: true,
  },
  gofmt: {
    cmd: "gofmt",
    buildArgs: (file) => ["-w", file],
    inPlace: true,
  },
  rustfmt: {
    cmd: "rustfmt",
    buildArgs: (file) => [file],
    inPlace: true,
  },
};

const formatCodeTool: ToolDefinition = {
  name: "format_code",
  description:
    "Run a code formatter on a file. `tool` is one of `prettier` (default, runs via `npx --no-install`), `black`, `gofmt`, `rustfmt`. The tool must be on PATH. Files are modified in place; the tool reports the formatter's stdout/stderr. Read-only is a misnomer — the file IS rewritten; this is a mutating tool that prompts in `safe` and auto-approves in `accept-edits`.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the sandbox root." },
      tool: {
        type: "string",
        description: "Formatter to use. Default 'prettier'. One of: prettier, black, gofmt, rustfmt.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  preview: (args) =>
    `format ${typeof args.path === "string" ? args.path : "?"} (${typeof args.tool === "string" ? args.tool : "prettier"})`,
  execute: async (args) => {
    try {
      const target = await resolveSafePath(String(args.path ?? ""));
      const s = await stat(target);
      if (!s.isFile()) return `Error: not a file: ${args.path}`;
      const toolName = String(args.tool ?? "prettier");
      const spec = FORMATTERS[toolName];
      if (!spec) {
        return `Error: unknown formatter '${toolName}'. Available: ${Object.keys(FORMATTERS).join(", ")}`;
      }
      const before = await readFile(target, "utf8");
      const args_ = spec.buildArgs(target);
      const result = await new Promise<{ code: number | null; out: string; err: string }>(
        (resolve) => {
          let out = "";
          let err = "";
          const child = spawn(spec.cmd, args_, { windowsHide: true });
          const timer = setTimeout(() => {
            try { child.kill("SIGKILL"); } catch { /* ignore */ }
            resolve({ code: null, out, err: err + "\n[timeout]" });
          }, TIMEOUT_MS);
          child.stdout.on("data", (c) => (out += c.toString("utf8")));
          child.stderr.on("data", (c) => (err += c.toString("utf8")));
          child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ code, out, err });
          });
          child.on("error", (spawnErr) => {
            clearTimeout(timer);
            resolve({ code: null, out: "", err: spawnErr.message });
          });
        },
      );
      // Most formatters are in-place; the success signal is exit 0.
      if (result.code !== 0) {
        // ENOENT is "command not found" — give a friendly hint.
        if (result.err.includes("ENOENT") || result.code === null) {
          return `Error: formatter '${toolName}' not found on PATH. ${result.err}`;
        }
        return `Error: formatter failed (exit ${result.code}): ${result.err || result.out}`;
      }
      // Report the byte-delta so the model knows whether anything changed.
      const after = await readFile(target, "utf8");
      const beforeBytes = Buffer.byteLength(before, "utf8");
      const afterBytes = Buffer.byteLength(after, "utf8");
      return `Formatted ${args.path} with ${toolName} (${beforeBytes} → ${afterBytes} bytes). ${result.out || ""}`.trim();
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const formatTools: ToolDefinition[] = [formatCodeTool];
