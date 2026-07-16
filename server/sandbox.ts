/**
 * HTTP-facing sandbox helpers for the Workspace Explorer sidebar.
 *
 * Reuses `resolveSafePath` from `./tools/sandbox.ts` so path-escape refusal,
 * absolute-path rejection, and the sandbox-root enforcement all stay
 * consistent with what the agent sees.
 *
 * Pure helpers — no DB, no Express, no async outside filesystem ops. The
 * route handlers in `server/index.ts` parse query params and translate
 * exceptions into 4xx responses.
 */

import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import { getSandboxRoot, resolveSafePath } from "./tools/sandbox.js";

export type TreeKind = "dir" | "file";

export interface SandboxTreeNode {
  name: string;
  kind: TreeKind;
  /** Bytes for files; null for dirs. */
  size: number | null;
  /** Only present for dirs whose subtrees were walked (i.e. depth not exhausted AND hasMore false). */
  children?: SandboxTreeNode[];
  /** True when the subtree was cut off because the walker hit depth or fan-out caps. */
  hasMore?: boolean;
  /** Number of entries that didn't get walked because of the cap; alongside `hasMore`. */
  truncatedChildCount?: number;
}

export interface SandboxTree {
  path: string;
  nodes: SandboxTreeNode[];
  /** Total number of file/dir entries skipped due to fan-out cap. */
  truncated: number;
}

export interface FileContent {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
}

/** Hard caps to keep responses bounded for hostile or huge workspaces. */
const FANOUT_PER_DIR = 500;
const DEFAULT_DEPTH = 5;
const MAX_DEPTH = 10;
const DEFAULT_MAX_BYTES = 64 * 1024;
const MAX_MAX_BYTES = 1024 * 1024;

/**
 * Walk a directory relative to the sandbox root, returning a tree with
 * `children` populated for directories walked within `maxDepth`. Beyond
 * `maxDepth` the directory node carries `hasMore: true` + `truncatedChildCount`
 * but no children.
 */
export async function walkSandbox(
  path: string = ".",
  maxDepth: number = DEFAULT_DEPTH,
): Promise<SandboxTree> {
  const depth = Math.min(Math.max(Math.trunc(Number(maxDepth) || DEFAULT_DEPTH), 1), MAX_DEPTH);
  const safeRoot = await realRoot();
  const startAbs = await safeResolve(safeRoot, path);
  const statResult = await stat(startAbs).catch(() => null);
  if (!statResult) {
    return { path, nodes: [], truncated: 0 };
  }

  let totalTruncated = 0;
  let result: SandboxTree;

  if (statResult.isFile()) {
    // Single-file request: render as one-node tree.
    result = {
      path,
      nodes: [
        {
          name: relName(startAbs, safeRoot),
          kind: "file",
          size: statResult.size,
        },
      ],
      truncated: 0,
    };
  } else {
    const top = await walkOne(startAbs, depth, 0, safeRoot);
    result = { path, nodes: top.children ?? [], truncated: top.truncatedChildCount ?? 0 };
    totalTruncated = result.truncated;
  }

  return result;
}

async function walkOne(
  absDir: string,
  maxDepth: number,
  currentDepth: number,
  safeRoot: string,
): Promise<SandboxTreeNode> {
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    return { name: relName(absDir, safeRoot), kind: "dir", size: null };
  }
  // Sort: dirs first, then alpha, with hidden files excluded.
  entries = entries
    .filter((e) => !e.name.startsWith("."))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) {
        return a.isDirectory() ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

  // Always include up to FANOUT_PER_DIR; beyond that, mark `hasMore`.
  const truncatedCount = Math.max(0, entries.length - FANOUT_PER_DIR);
  const capped = entries.slice(0, FANOUT_PER_DIR);

  const children: SandboxTreeNode[] = await Promise.all(
    capped.map(async (e) => {
      const abs = join(absDir, e.name);
      if (e.isDirectory()) {
        if (currentDepth + 1 >= maxDepth) {
          // Hit the depth cap — surface a placeholder node. We don't
          // recurse, so truncatedChildCount would normally be 0; use -1
          // as a sentinel for depth-limited so the UI can render a
          // ... affordance without confusing it with a fully-emitted
          // empty dir.
          return {
            name: e.name,
            kind: "dir" as const,
            size: null,
            hasMore: true,
            truncatedChildCount: -1,
          };
        }
        const inner = await walkOne(abs, maxDepth, currentDepth + 1, safeRoot);
        return inner;
      }
      const s = await stat(abs).catch(() => null);
      return {
        name: e.name,
        kind: "file" as const,
        size: s?.size ?? null,
      };
    }),
  );

  const node: SandboxTreeNode = {
    name: relName(absDir, safeRoot),
    kind: "dir",
    size: null,
  };
  if (children.length > 0) node.children = children;
  if (truncatedCount > 0) {
    node.hasMore = true;
    node.truncatedChildCount = truncatedCount;
  }
  return node;
}

async function safeResolve(safeRoot: string, relativePath: string): Promise<string> {
  // Reuse the same path-canary logic the agent tools use.
  const safe = await resolveSafePath(relativePath);
  if (!isInside(safe, safeRoot)) {
    // Should never happen; resolveSafePath would have thrown.
    throw new Error("resolved path is outside the sandbox root");
  }
  return safe;
}

function relName(abs: string, root: string): string {
  const rel = relative(root, abs);
  if (rel === "" || rel === ".") return ".";
  if (rel.split(sep).every((p) => p !== "..")) return rel;
  // Shouldn't happen post-resolveSafePath. Throw rather than leak the
  // absolute sandbox path into the API response.
  throw new Error(`internal: computed path escapes sandbox root: ${abs}`);
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  if (rel === "" || rel === ".") return true;
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  return rel.split(sep).every((p) => p !== "..");
}

/**
 * Read a file in the sandbox, capped at `maxBytes`. Returns UTF-8 text content.
 * Throws on size/disk errors; the caller turns those into HTTP 404.
 */
export async function readSandboxFile(
  relPath: string,
  maxBytes: number = DEFAULT_MAX_BYTES,
): Promise<FileContent> {
  const cap = Math.min(Math.max(Math.trunc(Number(maxBytes) || DEFAULT_MAX_BYTES), 1024), MAX_MAX_BYTES);
  const abs = await resolveSafePath(relPath);
  const s = await stat(abs).catch(() => null);
  if (!s || !s.isFile()) {
    const err = new Error(`not a file: ${relPath}`);
    (err as Error & { status?: number }).status = 404;
    throw err;
  }
  // Cap read at the smaller of cap or actual size.
  const bytesToRead = Math.min(cap, s.size);
  const fh = await import("node:fs/promises").then((m) => m.open(abs, "r"));
  try {
    const buf = Buffer.alloc(bytesToRead);
    const { bytesRead } = await fh.read(buf, 0, bytesToRead, 0);
    return {
      path: relPath,
      content: buf.subarray(0, bytesRead).toString("utf8"),
      size: s.size,
      truncated: s.size > cap,
    };
  } finally {
    await fh.close();
  }
}

async function realRoot(): Promise<string> {
  try {
    return await realpath(getSandboxRoot());
  } catch {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(getSandboxRoot(), { recursive: true });
    return await realpath(getSandboxRoot());
  }
}




