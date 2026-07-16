/**
 * Sandbox path resolution. All file-touching tools route their relative paths
 * through `resolveSafePath` so they cannot escape the configured sandbox root.
 *
 * Rules:
 *  - Input must be a non-empty relative path. Absolute paths (POSIX `/foo`,
 *    Windows `C:\foo`, UNC `\\server\share\foo`) are rejected up front.
 *  - The candidate is resolved against the current sandbox root, then
 *    realpath'd when the target exists. realpath'ing the root and walking
 *    the relative path closes the obvious `..` traversal and the symlink
 *    escape trick.
 *  - If the resolved path lies outside the root, throw.
 *
 * The sandbox root is set once at boot (env var or `os.homedir()` fallback)
 * and can be changed at runtime via `setSandboxRoot()`. All consumers read
 * through `getSandboxRoot()` so they pick up the new value automatically.
 */

import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { relative, resolve, sep, isAbsolute } from "node:path";

function initialSandboxRoot(): string {
  const fromEnv = process.env.TOOL_SANDBOX_ROOT;
  if (fromEnv && fromEnv.trim().length > 0) {
    return resolve(fromEnv);
  }
  // No env var: pick a path outside the project tree. We deliberately
  // avoid `process.cwd() + "workspace"` because that lives inside the
  // project, and Vite watches the whole project directory — see
  // .env.example for the full explanation.
  try {
    return resolve(homedir(), "agent-sandbox");
  } catch {
    // Last resort: a hidden dir at the user's home. Still outside the
    // project (and not the cwd), so Vite stays quiet.
    return resolve(homedir(), ".agent-sandbox");
  }
}

/**
 * Synchronous project-overlap check used at boot to warn (not throw) when
 * the env-var points at a path inside the project. We don't throw so a
 * developer who's intentionally using a project-internal sandbox during
 * early prototyping isn't locked out; the warning is the signal.
 */
function warnIfInsideProject(path: string): void {
  try {
    const projectRoot = process.cwd().replace(/\\/g, "/").replace(/\/+$/, "");
    const t = path.replace(/\\/g, "/").replace(/\/+$/, "");
    if (t === projectRoot || t.startsWith(projectRoot + "/")) {
      // eslint-disable-next-line no-console
      console.warn(
        `[sandbox] TOOL_SANDBOX_ROOT (${path}) is inside the project tree (${projectRoot}). ` +
          `The agent's file/exec activity will trigger Vite full-reloads. ` +
          `Move it OUTSIDE the project — see .env.example.`,
      );
    }
  } catch {
    // Best-effort warning only.
  }
}

let sandboxRoot: string = initialSandboxRoot();
warnIfInsideProject(sandboxRoot);

/** Get the current sandbox root (absolute path). */
export function getSandboxRoot(): string {
  return sandboxRoot;
}

/**
 * Switch the active sandbox root. Validates that `path` is absolute and
 * points at an existing directory; throws otherwise. Returns the resolved
 * (realpath'd) path on success.
 */
export async function setSandboxRoot(path: string): Promise<string> {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("path is required");
  }
  // Reject null bytes and other path-traversal tricks up front.
  if (path.includes("\0")) {
    throw new Error("path contains a null byte");
  }
  const candidate = resolve(path);
  if (!isAbsolute(candidate)) {
    throw new Error("path must be absolute");
  }
  let real: string;
  try {
    real = await realpath(candidate);
  } catch (err) {
    throw new Error(
      `path does not exist or is not accessible: ${path} (${(err as Error).message})`,
    );
  }
  // Defense in depth: refuse to point the sandbox at a path that lives
  // inside (or equal to) the project tree. Vite watches the whole project
  // directory; if the agent writes inside it, the dev server full-reloads
  // and re-typechecks any nested TS project, pausing chat for several
  // seconds. The caller is expected to set TOOL_SANDBOX_ROOT to a sibling
  // path (e.g. C:\Users\YOU\agent-sandbox) instead.
  if (await isInsideProject(real)) {
    throw new Error(
      `sandbox root is inside the project tree (${real}); choose a path OUTSIDE the project — see .env.example`,
    );
  }
  const s = await import("node:fs/promises").then((m) => m.stat(real));
  if (!s.isDirectory()) {
    throw new Error(`path is not a directory: ${path}`);
  }
  sandboxRoot = real;
  return real;
}

/**
 * True if `target` lives inside (or equals) the dev server's project
 * directory. We use the cwd of the running server as a proxy for "the
 * project" — for `tsx server/index.ts` from the repo root that's correct.
 * If the server is launched from elsewhere, the comparison may be looser
 * than ideal, but the property is still monotonic: a project-internal
 * path always starts with the cwd.
 */
async function isInsideProject(target: string): Promise<boolean> {
  const projectRoot = await realpath(process.cwd()).catch(() => process.cwd());
  if (target === projectRoot) return true;
  // Cross-platform: normalise to forward slashes before the prefix check.
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const t = norm(target);
  const r = norm(projectRoot);
  return t === r || t.startsWith(r + "/");
}

/**
 * @deprecated Use `getSandboxRoot()` instead. Kept as a value for callers
 * that import it directly (still resolves correctly at import time).
 */
export const SANDBOX_ROOT: string = sandboxRoot;

async function realRoot(): Promise<string> {
  try {
    return await realpath(getSandboxRoot());
  } catch {
    // Sandbox root doesn't exist yet. Create it lazily on first use.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(getSandboxRoot(), { recursive: true });
    return await realpath(getSandboxRoot());
  }
}

function isAbsoluteLike(p: string): boolean {
  if (!p) return true; // empty is treated as "absolute" (i.e. invalid)
  if (isAbsolute(p)) return true;
  // Windows drive letters or UNC even when the OS reports it as relative.
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true;
  if (p.startsWith("\\\\") || p.startsWith("//")) return true;
  return false;
}

/**
 * Resolve `relativePath` (which the model supplied) to an absolute path on
 * disk that is guaranteed to live inside the current sandbox root.
 */
export async function resolveSafePath(relativePath: string): Promise<string> {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new Error("path is required");
  }
  if (isAbsoluteLike(relativePath)) {
    const e = new Error("path must be relative to the sandbox root") as Error & { status?: number };
    e.status = 400;
    throw e;
  }
  const root = await realRoot();
  const candidate = resolve(root, relativePath);
  // Realpath when the target exists; for write paths that don't exist yet
  // we accept the candidate and rely on the relative-walk check below.
  let real = candidate;
  try {
    real = await realpath(candidate);
  } catch {
    // ENOENT / ENOTDIR: candidate may not exist yet. We still need to walk
    // the path to confirm no `..` slips through. Use the candidate as the
    // check target, but anchor against `root` (which is a realpath already).
  }
  const rel = relative(root, real);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && rel.split(sep).every((p) => p !== ".."))) {
    return real;
  }
  const e = new Error(`path escapes sandbox root: ${relativePath}`) as Error & { status?: number };
  e.status = 400;
  throw e;
}

/** Lightweight format helper for tool outputs. */
export function describePath(p: string): string {
  return relative(getSandboxRoot(), p) || ".";
}
