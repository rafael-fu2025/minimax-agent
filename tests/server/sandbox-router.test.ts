/**
 * Sandbox router mutation tests. Spins up an ephemeral Express app on a
 * random port, points `TOOL_SANDBOX_ROOT` at a fresh tmp dir, then drives
 * the four mutation endpoints + restore through real HTTP.
 *
 * Covers:
 *   - mkdir (creates a dir; recursive by default)
 *   - rename (moves a file to a new location)
 *   - delete (rename-to-trash; returns a trashPath; restore reverses it)
 *   - upload (raw binary body, parent dirs auto-created)
 *   - delete a missing file surfaces a 404 status
 *   - restore with destination taken surfaces a 409 status
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mounting the router also calls setSandboxRoot through resolveSafePath,
// so we have to set the env var BEFORE importing the router module.
let app: express.Express;
let server: Server;
let baseUrl: string;
let tmpRoot: string;

async function startServer() {
  tmpRoot = await mkdtemp(join(tmpdir(), "sandbox-router-test-"));
  process.env.TOOL_SANDBOX_ROOT = tmpRoot;

  // Force a fresh module graph so tools/sandbox.ts re-reads TOOL_SANDBOX_ROOT
  // and resolves getSandboxRoot() against the new temp dir. Without this
  // reset, every test after the first operates on the first test's tmp.
  vi.resetModules();
  const routerMod = await import("../../server/routers/sandbox.router.js");
  const sandboxMod = await import("../../server/tools/sandbox.js");
  // Confirm the picked-up root matches our tmp dir, otherwise debugging will
  // be confusing.
  if (sandboxMod.getSandboxRoot() !== tmpRoot) {
    throw new Error("sandbox root mismatch: env=" + tmpRoot + " module=" + sandboxMod.getSandboxRoot());
  }

  app = express();
  app.use(express.json({ limit: "1mb" }));
  routerMod.mountSandboxRouter(app);

  const srv = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
  server = srv;
  const addr = srv.address();
  if (typeof addr !== "object" || !addr) throw new Error("no address");
  baseUrl = "http://127.0.0.1:" + addr.port;
}

async function stopServer() {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  delete process.env.TOOL_SANDBOX_ROOT;
}

beforeEach(startServer);
afterEach(stopServer);

async function req(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(baseUrl + path, init);
  return res;
}

async function reqJson<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T; raw: string }> {
  const res = await req(path, init);
  const text = await res.text();
  let body: T;
  try { body = JSON.parse(text) as T; } catch { throw new Error("non-JSON response for " + path + " status=" + res.status + " body=" + text.slice(0, 300)); }
  return { status: res.status, body, raw: text };
}

describe("POST /api/sandbox/mkdir", () => {
  it("creates a new directory inside the sandbox root", async () => {
    const res = await reqJson<{ path: string }>("/api/sandbox/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "newdir/sub" }),
    });
    expect(res.status).toBe(200);
    expect(res.body.path).toBe("newdir/sub");
    const entries = await readdir(join(tmpRoot, "newdir"));
    expect(entries).toContain("sub");
  });

  it("rejects empty path with 400", async () => {
    const res = await req("/api/sandbox/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/sandbox/rename", () => {
  it("renames a file via POSIX rename", async () => {
    await writeFile(join(tmpRoot, "before.txt"), "hi");
    const res = await reqJson<{ from: string; to: string }>("/api/sandbox/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: "before.txt", to: "after.txt" }),
    });
    expect(res.status).toBe(200);
    expect(res.body.to).toBe("after.txt");
    const files = await readdir(tmpRoot);
    expect(files).toContain("after.txt");
    expect(files).not.toContain("before.txt");
  });
});

describe("DELETE /api/sandbox/file", () => {
  it("moves a file into .trash/ and reports trashPath", async () => {
    await writeFile(join(tmpRoot, "victim.txt"), "bye");
    const res = await reqJson<{ path: string; trashPath: string }>("/api/sandbox/file", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "victim.txt" }),
    });
    expect(res.status).toBe(200);
    expect(res.body.trashPath).toMatch(/^[.]trash[\\/]/);
    // .trash/ exists with one entry; original gone from root.
    const trashEntries = await readdir(join(tmpRoot, ".trash"));
    expect(trashEntries.length).toBe(1);
    expect(trashEntries[0]).toContain("__victim.txt");
    const rootEntries = await readdir(tmpRoot);
    expect(rootEntries).not.toContain("victim.txt");
  });

  it("returns 404 when the target does not exist", async () => {
    const res = await req("/api/sandbox/file", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "ghost.txt" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/sandbox/restore", () => {
  it("moves a trashed file back to its original path", async () => {
    await writeFile(join(tmpRoot, "throwaway.txt"), "x");
    const del = await reqJson<{ path: string; trashPath: string }>("/api/sandbox/file", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "throwaway.txt" }),
    });
    expect(del.status).toBe(200);

    const restored = await reqJson<{ path: string }>("/api/sandbox/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashPath: del.body.trashPath, originalPath: "throwaway.txt" }),
    });
    expect(restored.status).toBe(200);
    expect(restored.body.path).toBe("throwaway.txt");
    const files = await readdir(tmpRoot);
    expect(files).toContain("throwaway.txt");
    expect(await readFile(join(tmpRoot, "throwaway.txt"), "utf8")).toBe("x");
  });

  it("returns 404 when the trash entry is gone", async () => {
    const res = await req("/api/sandbox/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashPath: ".trash/nope__x", originalPath: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 when restoring onto an existing directory", async () => {
    // Restore the trash entry ONTO a non-empty directory that already
    // exists. POSIX rename over a non-empty dir fails with ENOTEMPTY; on
    // Windows the kernel returns EPERM for "rename onto directory". Both
    // are translated to a 409 by the router.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(tmpRoot, "occupied"), { recursive: true });
    await writeFile(join(tmpRoot, "occupied", "child.txt"), "i am here");
    await writeFile(join(tmpRoot, "mover.txt"), "x");
    const del = await reqJson<{ path: string; trashPath: string }>("/api/sandbox/file", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "mover.txt" }),
    });
    expect(del.status).toBe(200);
    const restore = await req("/api/sandbox/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashPath: del.body.trashPath, originalPath: "occupied" }),
    });
    expect(restore.status).toBe(409);
  });
});

describe("POST /api/sandbox/upload", () => {
  it("writes the raw body to the requested path and creates parents", async () => {
    const buf = Buffer.from("hello, world");
    const res = await reqJson<{ path: string; bytes: number }>("/api/sandbox/upload?path=deep/nest/payload.bin", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: buf,
    });
    expect(res.status).toBe(200);
    expect(res.body.bytes).toBe(buf.length);
    const written = await readFile(join(tmpRoot, "deep", "nest", "payload.bin"));
    expect(written.toString("utf8")).toBe("hello, world");
  });

  it("returns 400 when path query param is missing", async () => {
    const res = await req("/api/sandbox/upload", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: Buffer.from("x"),
    });
    expect(res.status).toBe(400);
  });
});

describe("path-canary", () => {
  it("rejects absolute paths with 400", async () => {
    const res = await req("/api/sandbox/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "C:\\Windows" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects .. escapes", async () => {
    const res = await req("/api/sandbox/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "../escape" }),
    });
    expect(res.status).toBe(400);
  });
});


