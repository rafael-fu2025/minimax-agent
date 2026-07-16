/**
 * File-system tools. All four go through `resolveSafePath` from
 * `./sandbox.ts` so the model can never reach outside the configured root.
 */

import { readFile, writeFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { resolveSafePath, describePath } from "./sandbox.js";
import type { ToolDefinition } from "../tools.js";
import type { ToolApprovalMode } from "./approval.js";

/** Context passed to every tool's `execute` so per-tool gating is mode-aware. */
export interface ToolExecContext {
  permissionMode: ToolApprovalMode;
}

const MAX_READ_BYTES = 256 * 1024; // 256 KiB

const readFileTool: ToolDefinition = {
  name: "read_file",
  description:
    "Read a UTF-8 text file at <path> relative to the sandbox root. Returns up to 256 KiB; for larger files, use `search_files` first to confirm what you want.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative path, e.g. 'src/index.ts' or 'docs/notes.md'.",
      },
      max_bytes: {
        type: "number",
        description: "Override the 256 KiB cap. Min 1 KiB, max 4 MiB.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  execute: async (args) => {
    try {
      const target = await resolveSafePath(String(args.path ?? ""));
      const cap = clampInt(args.max_bytes, 1024, 4 * 1024 * 1024, MAX_READ_BYTES);
      const fh = await openWithCap(target, cap);
      try {
        const buf = await fh.readFile();
        if (buf.length >= cap) {
          return `${buf.toString("utf8")}\n\n[truncated at ${cap} bytes; file is larger]`;
        }
        return buf.toString("utf8");
      } finally {
        await fh.close();
      }
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

const writeFileTool: ToolDefinition = {
  name: "write_file",
  description:
    "Write UTF-8 text to <path> relative to the sandbox root, overwriting if it exists. Creates parent directories as needed.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative path, e.g. 'docs/test.txt'.",
      },
      content: {
        type: "string",
        description: "Full file content to write.",
      },
      append: {
        type: "boolean",
        description: "If true, append to the file instead of overwriting.",
      },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  preview: (args) => {
    const p = typeof args.path === "string" ? args.path : "(unknown path)";
    const append = args.append ? "  [append]" : "";
    return `write → ${p}${append}`;
  },
  execute: async (args) => {
    try {
      const target = await resolveSafePath(String(args.path ?? ""));
      const content = String(args.content ?? "");
      const append = Boolean(args.append);
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(target, ".."), { recursive: true });
      const { open } = await import("node:fs/promises");
      const fh = await open(target, append ? "a" : "w");
      try {
        await fh.writeFile(content, "utf8");
      } finally {
        await fh.close();
      }
      return `Wrote ${content.length} bytes to ${describePath(target)} (${append ? "appended" : "overwritten"})`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

const deleteFileTool: ToolDefinition = {
  name: "delete_file",
  description:
    "Delete a file at <path> relative to the sandbox root. Returns 'Deleted <path>' on success or an error string. **Prefer this over `exec_command del …` / `rm …`** — it bypasses any shell-quoting edge cases and works identically on Windows and Linux. Use this to remove a scratch file, an outdated log, or any artifact the user asked to delete.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative path to the file to delete, e.g. 'docs/notes.md' or 'index.html'.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  preview: (args) => `delete → ${typeof args.path === "string" ? args.path : "(unknown path)"}`,
  execute: async (args) => {
    try {
      const target = await resolveSafePath(String(args.path ?? ""));
      // Refuse to delete a directory — that's a recursive op the model
      // shouldn't be triggering without an explicit recursive flag.
      const s = await stat(target).catch(() => null);
      if (!s) {
        return `Error: file not found: ${args.path}`;
      }
      if (s.isDirectory()) {
        return `Error: ${args.path} is a directory; delete_file only removes files. Use list_dir + per-file delete_file instead.`;
      }
      await unlink(target);
      return `Deleted ${describePath(target)}`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

const listDirTool: ToolDefinition = {
  name: "list_dir",
  description:
    "List entries in a directory at <path> relative to the sandbox root. Returns name, type, and size for each entry. Does not recurse.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative directory path; use '.' for the root.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  execute: async (args) => {
    try {
      const target = await resolveSafePath(String(args.path ?? "."));
      const entries = await readdir(target, { withFileTypes: true });
      const rows: string[] = [];
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        try {
          const s = await stat(join(target, e.name));
          const kind = e.isDirectory() ? "dir" : e.isFile() ? "file" : "other";
          const size = e.isFile() ? `${s.size}b` : "";
          rows.push(`${kind.padEnd(4)}  ${e.name}${size ? "  " + size : ""}`);
        } catch {
          rows.push(`${e.isDirectory() ? "dir" : "file"}  ${e.name}`);
        }
      }
      if (rows.length === 0) return "(empty directory)";
      return rows.join("\n");
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

const searchFilesTool: ToolDefinition = {
  name: "search_files",
  description:
    "Walk a directory and return paths matching a glob-like <pattern>. Supports `*` and `**` for path segments, plus `?<char>` and `[abc]`. Recursive. Returns relative paths.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Glob pattern, e.g. '**/*.ts' or 'src/*.json'.",
      },
      root: {
        type: "string",
        description: "Directory to search in, relative to the sandbox root. Default '.'.",
      },
      max_results: {
        type: "number",
        description: "Cap on returned paths. Default 200.",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  execute: async (args) => {
    try {
      const pattern = String(args.pattern ?? "").trim();
      if (!pattern) return "Error: pattern is required";
      const rootArg = String(args.root ?? ".");
      const max = clampInt(args.max_results, 1, 10_000, 200);
      const root = await resolveSafePath(rootArg);
      const matcher = globToRegExp(pattern);
      const out: string[] = [];
      await walk(root, "", matcher, out, max);
      if (out.length === 0) return "(no matches)";
      if (out.length >= max) {
        return out.join("\n") + `\n[truncated at ${max} results]`;
      }
      return out.join("\n");
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const fsTools: ToolDefinition[] = [
  readFileTool,
  writeFileTool,
  listDirTool,
  searchFilesTool,
  deleteFileTool,
];

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

function clampInt(value: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), lo), hi);
}

async function openWithCap(target: string, cap: number) {
  const { open } = await import("node:fs/promises");
  return await open(target, "r");
}

function globToRegExp(pattern: string): RegExp {
  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // ** matches any number of path segments, including none
        regex += ".*";
        i += 2;
        if (pattern[i] === "/") i += 1;
      } else {
        // * matches a single segment's worth of chars (no slashes)
        regex += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      regex += "[^/]";
      i += 1;
    } else if (c === "[") {
      const end = pattern.indexOf("]", i);
      if (end === -1) {
        regex += "\\[";
        i += 1;
      } else {
        regex += pattern.slice(i, end + 1);
        i = end + 1;
      }
    } else if (/[.+^$(){}|\\]/.test(c)) {
      regex += "\\" + c;
      i += 1;
    } else {
      regex += c;
      i += 1;
    }
  }
  regex += "$";
  return new RegExp(regex);
}

/** Exported for the unit test in `tests/tools/glob.test.ts`. */
export { globToRegExp };

async function walk(
  absRoot: string,
  relSoFar: string,
  matcher: RegExp,
  out: string[],
  max: number,
): Promise<void> {
  if (out.length >= max) return;
  let entries;
  try {
    entries = await readdir(join(absRoot, relSoFar), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= max) return;
    const rel = relSoFar ? `${relSoFar}/${entry.name}` : entry.name;
    if (matcher.test(rel)) {
      out.push(rel);
      if (out.length >= max) return;
    }
    if (entry.isDirectory()) {
      await walk(absRoot, rel, matcher, out, max);
    }
  }
}

