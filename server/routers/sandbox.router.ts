/**
 * Sandbox router — `/api/sandbox/*`.
 *
 * Read-only sandbox endpoints powering the Workspace Explorer sidebar. Both
 * resolve paths through the same safe sandbox logic the agent tools use, so
 * a `..` traversal or absolute path returns 4xx.
 */

import express from "express";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readSandboxFile, walkSandbox } from "../sandbox.js";
import { getSandboxRoot, resolveSafePath, setSandboxRoot } from "../tools/sandbox.js";


/**
 * Extract a string field from `req.body` and validate it. Throws an
 * `Error` with `status: 400` if the field is missing or empty.
 */
function requireString(body: unknown, key: string): string {
  const v = (body as Record<string, unknown> | null)?.[key];
  if (typeof v !== "string" || v.trim().length === 0) {
    const e = new Error(`${key} is required`) as Error & { status?: number };
    e.status = 400;
    throw e;
  }
  return v.trim();
}

/**
 * Wraps a sandbox mutation. Catches thrown `Error`s and translates them
 * into a JSON `{error}` body with the correct status code. Path-canary
 * failures (escape, absolute path, missing) flow through unchanged
 * because they already carry `status: 400` from `resolveSafePath`.
 */
async function handle(
  res: express.Response,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    const data = await fn();
    res.json(data);
  } catch (err) {
    const e = err as Error & { status?: number };
    res.status(e.status ?? 500).json({ error: e.message });
  }
}
/**
 * Recycle bin sits inside the sandbox at .trash/. Every delete is a
 * rename INTO this folder; an Undo renames it back. Keeping the trash
 * inside the sandbox means it stays subject to resolveSafePath + the
 * fanout / depth caps, and gets cleared when the user wipes the workspace.
 */
const TRASH_DIR = ".trash";

function trashPath(absSource: string) {
  // Date.now() base36 + short random suffix so two deletes in the same ms
  // do not collide.
  const stamp = Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  const parts = absSource.split(/[\\/]/);
  const base = parts.pop() || "item";
  const parent = parts.join("/") || getSandboxRoot();
  const name = stamp + "__" + base;
  return {
    absTarget: join(parent, TRASH_DIR, name),
    relTarget: join(TRASH_DIR, name),
  };
}

export function mountSandboxRouter(app: express.Express): void {
  app.get("/api/sandbox/tree", async (req, res) => {
    const path =
      typeof req.query.path === "string" && req.query.path.length > 0
        ? req.query.path
        : ".";
    const depth =
      Number(req.query.depth) > 0 ? Number(req.query.depth) : undefined;
    try {
      const tree = await walkSandbox(path, depth);
      res.json(tree);
    } catch (err) {
      const e = err as Error & { status?: number };
      const status = e.status ?? 400;
      res.status(status).json({ error: e.message });
    }
  });

  app.get("/api/sandbox/file", async (req, res) => {
    const path = typeof req.query.path === "string" ? req.query.path : "";
    if (!path) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    const maxBytes =
      Number(req.query.max_bytes) > 0 ? Number(req.query.max_bytes) : undefined;
    try {
      const file = await readSandboxFile(path, maxBytes);
      res.json(file);
    } catch (err) {
      const e = err as Error & { status?: number };
      const status = e.status ?? 400;
      res.status(status).json({ error: e.message });
    }
  });

  /**
   * Get the active sandbox root (the directory all file/terminal tools are
   * scoped to). Returned alongside a flag indicating whether the value is the
   * process-startup default or a runtime override.
   */
  app.get("/api/sandbox/root", (_req, res) => {
    res.json({
      root: getSandboxRoot(),
      isDefault: !process.env.TOOL_SANDBOX_ROOT,
      platform: process.platform,
    });
  });

  /**
   * Change the active sandbox root at runtime. Validates that the path is
   * absolute and points at an existing directory; refuses otherwise. After a
   * successful change, the next `/api/sandbox/tree` and `/api/sandbox/file`
   * calls (and all subsequent agent tool calls) use the new root.
   */
  app.post("/api/sandbox/root", async (req, res) => {
    const path =
      typeof req.body?.path === "string" ? req.body.path.trim() : "";
    if (!path) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    try {
      const resolved = await setSandboxRoot(path);
      res.json({ root: resolved, isDefault: false, platform: process.platform });
    } catch (err) {
      const e = err as Error & { status?: number };
      const status = e.status ?? 400;
      res.status(status).json({ error: e.message });
    }
  });

  /**
   * Create a directory. Body: `{ path: string; recursive?: boolean }`.
   * Refuses paths that escape the sandbox root.
   */
  app.post("/api/sandbox/mkdir", (req, res) =>
    handle(res, async () => {
      const p = requireString(req.body, "path");
      const target = await resolveSafePath(p);
      const recursive = (req.body as { recursive?: boolean } | null)?.recursive !== false;
      await mkdir(target, { recursive });
      return { path: p };
    }),
  );

  /**
   * Rename or move a file or directory. Body: `{ from: string; to: string }`.
   * Refuses when the destination already exists.
   */
  app.post("/api/sandbox/rename", (req, res) =>
    handle(res, async () => {
      const from = requireString(req.body, "from");
      const to = requireString(req.body, "to");
      const fromAbs = await resolveSafePath(from);
      const toAbs = await resolveSafePath(to);
      await rename(fromAbs, toAbs);
      return { from, to };
    }),
  );

  /**
   * Delete a file or directory. Body: `{ path: string }`. The target is
   * moved into `.trash/` (a sibling directory inside the sandbox) so the
   * operation is reversible via `/api/sandbox/restore`. Returns
   * `{ path, trashPath }` so the client can surface an Undo affordance.
   */
  app.delete("/api/sandbox/file", (req, res) =>
    handle(res, async () => {
      const p = requireString(req.body, "path");
      const target = await resolveSafePath(p);
      const { absTarget, relTarget } = trashPath(target);
      await mkdir(join(getSandboxRoot(), TRASH_DIR), { recursive: true });
      try {
        await rename(target, absTarget);
      } catch (e) {
        const err = e as NodeJS.ErrnoException & { status?: number };
        if (err.code === "ENOENT") err.status = 404;
        throw err;
      }
      return { path: p, trashPath: relTarget };
    }),
  );

  /**
   * Upload a file from the browser. Uses `multipart/form-data` with
   * `path` (the destination) and `file` (the binary). Capped at 50 MiB
   * to match the composer video cap; raise the limit if needed by
   * editing the constant below.
   */
  app.post("/api/sandbox/upload", express.raw({ type: "*/*", limit: "50mb" }), (req, res) => {
    const dest = typeof req.query.path === "string" ? req.query.path.trim() : "";
    if (!dest) { res.status(400).json({ error: "path query param is required" }); return; }
    handle(res, async () => {
      const target = await resolveSafePath(dest);
      // ensure parent dir exists so /api/sandbox/upload can create
      // a brand-new tree in one shot.
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, req.body as Buffer);
      return { path: dest, bytes: (req.body as Buffer).length };
    });
  });


  /**
   * Move a trashed entry back to its original location. Body:
   * { trashPath: string; originalPath: string }. Used by the Workspace
   * Explorer Undo affordance.
   */
  app.post("/api/sandbox/restore", (req, res) =>
    handle(res, async () => {
      const trashPath = requireString(req.body, "trashPath");
      const originalPath = requireString(req.body, "originalPath");
      const fromAbs = await resolveSafePath(trashPath);
      const toAbs = await resolveSafePath(originalPath);
      try {
        await rename(fromAbs, toAbs);
      } catch (e) {
        const err = e as NodeJS.ErrnoException & { status?: number; message: string };
        if (err.code === "ENOENT") {
          err.status = 404;
        } else if (err.code === "EEXIST" || err.code === "ENOTEMPTY" || err.code === "EPERM") {
          err.status = 409;
          err.message = "destination already exists; cannot Undo here";
        }
        throw err;
      }
      return { path: originalPath };
    }),
  );
}
