/**
 * `git_query` — single tool that runs `git status`, `git diff`, or `git log`
 * inside a repository. The user passes a `subcommand` ("status" | "diff" |
 * "log") and the optional args. Output is captured and returned.
 *
 * The cwd is whatever the user passes as `cwd` (default "."), resolved
 * through the same sandbox check as the file tools — git operations are
 * always within the sandbox.
 */

import { spawn } from "node:child_process";
import { resolveSafePath } from "./sandbox.js";
import type { ToolDefinition } from "../tools.js";

const TIMEOUT_MS = 30_000;

function runGit(args: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, TIMEOUT_MS);
    child.stdout.on("data", (c) => (out += c.toString("utf8")));
    child.stderr.on("data", (c) => (err += c.toString("utf8")));
    child.on("error", (spawnErr) => {
      clearTimeout(timer);
      resolve({ code: -1, out: "", err: spawnErr.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ code: code ?? -1, out, err: err + "\n[timed out]" });
      } else {
        resolve({ code: code ?? 0, out, err });
      }
    });
  });
}

const gitQueryTool: ToolDefinition = {
  name: "git_query",
  description:
    "Run a read-only git command in a repository directory. Supported subcommands: `status` (default), `diff`, `log`. `status` shows the working-tree state; `diff` shows the unstaged diff; `log` shows recent commits. Optional `args` is appended to the subcommand (e.g. `diff --stat`, `log -n 5`). For a `log` subcommand you can also pass `n` (default 20) and a `path` filter. Read-only — no approval needed.",
  parameters: {
    type: "object",
    properties: {
      subcommand: {
        type: "string",
        description: "One of: 'status', 'diff', 'log'. Default 'status'.",
      },
      cwd: {
        type: "string",
        description: "Repo directory, relative to the sandbox root. Default '.'.",
      },
      args: {
        type: "string",
        description: "Extra args to pass to git, e.g. '--stat' or '-n 10'.",
      },
      n: {
        type: "number",
        description: "For `log` only: number of commits to show. Default 20.",
      },
      path: {
        type: "string",
        description: "For `log` only: optional path filter (git log -- <path>).",
      },
    },
    additionalProperties: false,
  },
  preview: (args) =>
    `git ${String(args.subcommand ?? "status")}`,
  execute: async (args) => {
    try {
      const sub = String(args.subcommand ?? "status");
      const cwd = await resolveSafePath(String(args.cwd ?? "."));
      if (sub !== "status" && sub !== "diff" && sub !== "log") {
        return `Error: subcommand must be 'status', 'diff', or 'log'`;
      }
      const extra = args.args ? String(args.args).split(/\s+/).filter(Boolean) : [];
      const gitArgs: string[] = [sub, ...extra];
      if (sub === "log") {
        gitArgs.push(`-n`, String(args.n ?? 20), "--no-color");
        if (args.path) gitArgs.push("--", String(args.path));
      } else if (sub === "diff") {
        gitArgs.push("--no-color");
      }
      const result = await runGit(gitArgs, cwd);
      if (result.code !== 0 && result.code !== -1) {
        // Some `git` failures are expected (no repo, etc.) — show the
        // stderr but don't pretend the call failed catastrophically.
        return `(exit ${result.code})\nstderr: ${result.err || "(none)"}\nstdout: ${result.out || "(empty)"}`;
      }
      if (result.err && !result.out) {
        return result.err;
      }
      return result.out || "(no output)";
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const gitTools: ToolDefinition[] = [gitQueryTool];
