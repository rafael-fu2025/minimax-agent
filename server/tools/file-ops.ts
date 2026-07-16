/**
 * File-system operations beyond the slice-3 set: move, create_directory,
 * patch_file (apply a unified diff), diff_files (compute a unified diff
 * between two paths). All route through `resolveSafePath` so the model
 * cannot reach outside the configured sandbox root.
 */

import { rename, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { relative, resolve as pathResolve } from "node:path";
import { resolveSafePath, getSandboxRoot } from "./sandbox.js";
import type { ToolDefinition } from "../tools.js";

/* -------------------------------------------------------------------------- */
/* move_file                                                                  */
/* -------------------------------------------------------------------------- */

const moveFileTool: ToolDefinition = {
  name: "move_file",
  description:
    "Move or rename a file or directory within the sandbox. Both `from` and `to` are relative paths. Refuses if the destination already exists.",
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", description: "Source path, relative to the sandbox root." },
      to: { type: "string", description: "Destination path, relative to the sandbox root." },
    },
    required: ["from", "to"],
    additionalProperties: false,
  },
  preview: (args) =>
    `move ${typeof args.from === "string" ? args.from : "?"} → ${
      typeof args.to === "string" ? args.to : "?"
    }`,
  execute: async (args) => {
    try {
      const fromAbs = await resolveSafePath(String(args.from ?? ""));
      const toAbs = await resolveSafePath(String(args.to ?? ""));
      // Reject if destination already exists.
      try {
        await stat(toAbs);
        return `Error: destination already exists: ${args.to}`;
      } catch {
        // Good — destination does not exist.
      }
      await rename(fromAbs, toAbs);
      return `Moved ${args.from} → ${args.to}`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

/* -------------------------------------------------------------------------- */
/* create_directory                                                           */
/* -------------------------------------------------------------------------- */

const createDirectoryTool: ToolDefinition = {
  name: "create_directory",
  description:
    "Create a directory at <path> relative to the sandbox root. Creates parent directories as needed. Refuses to operate outside the sandbox root.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path, relative to the sandbox root." },
      recursive: {
        type: "boolean",
        description: "Create parent directories as needed. Default true.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  preview: (args) =>
    `mkdir ${typeof args.path === "string" ? args.path : "?"}`,
  execute: async (args) => {
    try {
      const target = await resolveSafePath(String(args.path ?? ""));
      const recursive = args.recursive !== false;
      await mkdir(target, { recursive });
      return `Created directory ${args.path}`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

/* -------------------------------------------------------------------------- */
/* patch_file (unified diff applier)                                          */
/* -------------------------------------------------------------------------- */

interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

function parseUnifiedDiff(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  for (const block of patch.split(/^diff --git /m)) {
    if (!block.trim()) continue;
    const lines = block.split("\n");
    let i = 0;
    // Skip the header line we just split on.
    while (i < lines.length && !lines[i].startsWith("@@")) i++;
    while (i < lines.length) {
      const headerMatch = lines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!headerMatch) {
        i++;
        continue;
      }
      const oldStart = Number(headerMatch[1]);
      const oldLines = Number(headerMatch[2] ?? "1");
      const newStart = Number(headerMatch[3]);
      const newLines = Number(headerMatch[4] ?? "1");
      const hunkLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("diff --git ")) {
        hunkLines.push(lines[i]);
        i++;
      }
      hunks.push({ oldStart, oldLines, newStart, newLines, lines: hunkLines });
    }
  }
  return hunks;
}

const patchFileTool: ToolDefinition = {
  name: "patch_file",
  description:
    "Apply a unified diff to a file at <path>. The diff must follow the standard `@@ -oldStart,oldLines +newStart,newLines @@` format. The hunk's old-side context must match the file exactly (no fuzzy matching). Use this for surgical edits instead of overwriting the whole file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the sandbox root." },
      patch: {
        type: "string",
        description:
          "Unified diff content (including the @@ hunk headers). Multiple hunks are supported.",
      },
    },
    required: ["path", "patch"],
    additionalProperties: false,
  },
  preview: (args) =>
    `patch → ${typeof args.path === "string" ? args.path : "?"}`,
  execute: async (args) => {
    try {
      const target = await resolveSafePath(String(args.path ?? ""));
      const hunks = parseUnifiedDiff(String(args.patch ?? ""));
      if (hunks.length === 0) return `Error: no @@ hunks found in patch`;
      const original = await readFile(target, "utf8");
      const originalLines = original.split("\n");

      // Apply hunks in order, adjusting offsets as we go.
      const result: string[] = [...originalLines];
      let offset = 0;
      for (const hunk of hunks) {
        const startIdx = hunk.oldStart - 1 + offset;
        // Pull the old-side context lines from the result.
        const oldContext: string[] = [];
        for (const ln of hunk.lines) {
          if (ln.startsWith("-") || ln.startsWith(" ")) {
            oldContext.push(ln.slice(1));
          }
        }
        const actual = result.slice(startIdx, startIdx + hunk.oldLines);
        if (
          actual.length !== oldContext.length ||
          oldContext.some((line, i) => actual[i] !== line)
        ) {
          return `Error: hunk context mismatch at line ${hunk.oldStart}: expected\n  ${oldContext
            .map((l) => l || "(blank)")
            .join("\n  ")}\ngot\n  ${actual
            .map((l) => l || "(blank)")
            .join("\n  ")}`;
        }
        // Build replacement lines.
        const replacement: string[] = [];
        for (const ln of hunk.lines) {
          if (ln.startsWith("+")) replacement.push(ln.slice(1));
        }
        // Splice.
        result.splice(startIdx, hunk.oldLines, ...replacement);
        offset += replacement.length - hunk.oldLines;
      }
      await writeFile(target, result.join("\n"), "utf8");
      return `Applied ${hunks.length} hunk${hunks.length === 1 ? "" : "s"} to ${args.path}`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

/* -------------------------------------------------------------------------- */
/* diff_files                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Compute a small LCS-based unified diff. Not optimized for huge files;
 * capped at 50 KiB per file at the executor level (tool description).
 */
function unifiedDiff(a: string[], b: string[]): string {
  const n = a.length;
  const m = b.length;
  // LCS length matrix.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // Walk the matrix, emitting a unified-diff style block.
  const out: string[] = [];
  let i = 0;
  let j = 0;
  let hunkOldStart = 0;
  let hunkNewStart = 0;
  let hunkOld = 0;
  let hunkNew = 0;
  const flush = () => {
    if (hunkOld > 0 || hunkNew > 0) {
      out.push(
        `@@ -${hunkOldStart},${hunkOld} +${hunkNewStart},${hunkNew} @@`,
      );
    }
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      if (hunkOld > 0 || hunkNew > 0) {
        flush();
        hunkOld = hunkNew = 0;
      }
      i++;
      j++;
    } else {
      hunkOldStart ||= i + 1;
      hunkNewStart ||= j + 1;
      hunkOld++;
      hunkNew++;
      i++;
      j++;
    }
  }
  // Trailing.
  while (i < n) {
    hunkOldStart ||= i + 1;
    hunkOld++;
    i++;
  }
  while (j < m) {
    hunkNewStart ||= j + 1;
    hunkNew++;
    j++;
  }
  flush();
  return out.length === 0 ? "(no differences)" : out.join("\n");
}

const diffFilesTool: ToolDefinition = {
  name: "diff_files",
  description:
    "Return a unified diff between two files in the sandbox. Both paths are relative. Capped at 50 KiB per file (use this for text diffs, not large generated files).",
  parameters: {
    type: "object",
    properties: {
      a: { type: "string", description: "First file path, relative to the sandbox root." },
      b: { type: "string", description: "Second file path, relative to the sandbox root." },
    },
    required: ["a", "b"],
    additionalProperties: false,
  },
  preview: (args) =>
    `diff ${typeof args.a === "string" ? args.a : "?"} ${
      typeof args.b === "string" ? args.b : "?"
    }`,
  execute: async (args) => {
    try {
      const aPath = String(args.a ?? "");
      const bPath = String(args.b ?? "");
      const MAX = 50 * 1024;
      const [aStat, bStat] = await Promise.all([
        stat(aPath).catch(() => null),
        stat(bPath).catch(() => null),
      ]);
      if (!aStat || !bStat) {
        return `Error: file not found: ${!aStat ? aPath : bPath}`;
      }
      if (aStat.size > MAX || bStat.size > MAX) {
        return `Error: file too large (cap 50 KiB). a=${aStat.size}b b=${bStat.size}b`;
      }
      const [aText, bText] = await Promise.all([
        readFile(aPath, "utf8"),
        readFile(bPath, "utf8"),
      ]);
      const aLines = aText.split("\n");
      const bLines = bText.split("\n");
      const aRel = relative(getSandboxRoot(), aPath).replace(/\\/g, "/");
      const bRel = relative(getSandboxRoot(), bPath).replace(/\\/g, "/");
      const diff = unifiedDiff(aLines, bLines);
      return `--- a/${aRel}\n+++ b/${bRel}\n${diff}`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const fileOpsTools: ToolDefinition[] = [
  moveFileTool,
  createDirectoryTool,
  patchFileTool,
  diffFilesTool,
];
