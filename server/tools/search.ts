/**
 * `code_search` — ripgrep-style content search. Walks a directory, regex-
 * matches file contents, returns `{path, line, content}` rows. Capped at
 * 500 matches; skips common ignored directories (`.git`, `node_modules`,
 * `dist`, etc).
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { resolveSafePath, getSandboxRoot } from "./sandbox.js";
import type { ToolDefinition } from "../tools.js";

const MAX_MATCHES = 500;
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  "target",
]);
const MAX_FILE_BYTES = 1024 * 1024; // 1 MiB; skip binary-ish files past this

interface CodeMatch {
  path: string;
  line: number;
  content: string;
}

async function walk(
  abs: string,
  rel: string,
  regex: RegExp,
  matches: CodeMatch[],
): Promise<void> {
  if (matches.length >= MAX_MATCHES) return;
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (matches.length >= MAX_MATCHES) return;
    if (e.name.startsWith(".") && e.name !== ".env" && e.name !== ".gitignore") {
      // Skip hidden directories/files except for a few commonly searched.
      if (e.isDirectory()) continue;
    }
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walk(join(abs, e.name), join(rel, e.name).replace(/\\/g, "/"), regex, matches);
      continue;
    }
    if (!e.isFile()) continue;
    const absFile = join(abs, e.name);
    const s = await stat(absFile).catch(() => null);
    if (!s || s.size > MAX_FILE_BYTES) continue;
    // Only text files: try to read as utf-8; if it fails with decode error, skip.
    let content: string;
    try {
      content = await readFile(absFile, "utf8");
    } catch {
      continue;
    }
    const relPath = (rel ? rel + "/" : "") + e.name;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        matches.push({ path: relPath, line: i + 1, content: lines[i] });
        if (matches.length >= MAX_MATCHES) return;
      }
    }
  }
}

const codeSearchTool: ToolDefinition = {
  name: "code_search",
  description:
    "Search the contents of files in the sandbox for a regex pattern. Returns up to 500 matches as `path:line:content` rows. Walks the directory recursively starting at `root` (default `.`). Skips `.git/`, `node_modules/`, `dist/`, `build/`, etc. Skips files larger than 1 MiB. The `pattern` is a JavaScript regex (no quotes needed in the JSON args).",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          "JavaScript regex pattern, e.g. 'TODO' or 'function\\\\s+[A-Z]'. Backslashes must be doubled in the JSON string.",
      },
      root: {
        type: "string",
        description: "Directory to search in, relative to the sandbox root. Default '.'.",
      },
      max_results: {
        type: "number",
        description: "Cap on returned matches. Default 500.",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  preview: (args) =>
    `/${typeof args.pattern === "string" ? args.pattern : "?"}/`,
  execute: async (args) => {
    try {
      const pattern = String(args.pattern ?? "");
      if (!pattern) return "Error: pattern is required";
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, "i");
      } catch (err) {
        return `Error: invalid regex: ${(err as Error).message}`;
      }
      const rootArg = String(args.root ?? ".");
      const root = await resolveSafePath(rootArg);
      const max = Math.min(Math.max(Number(args.max_results ?? MAX_MATCHES), 1), MAX_MATCHES * 2);
      const matches: CodeMatch[] = [];
      const startRel = relative(getSandboxRoot(), root).replace(/\\/g, "/") || ".";
      await walk(root, startRel === "." ? "" : startRel, regex, matches);
      const trimmed = matches.slice(0, max);
      if (trimmed.length === 0) return "(no matches)";
      if (matches.length > max) {
        return (
          trimmed.map((m) => `${m.path}:${m.line}: ${m.content}`).join("\n") +
          `\n[truncated at ${max} results; total matches: ${matches.length}]`
        );
      }
      return trimmed.map((m) => `${m.path}:${m.line}: ${m.content}`).join("\n");
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const searchTools: ToolDefinition[] = [codeSearchTool];
