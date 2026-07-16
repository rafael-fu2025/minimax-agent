/**
 * `exec_command` — run a shell command in the sandbox root.
 *
 * Safety layering:
 *   1. `isBlocked(command)` — reject obvious destructive patterns
 *      (rm -rf /, fork bomb, mkfs, sudo, curl|sh, …).
 *   2. cwd is forced to SANDBOX_ROOT so the shell can't `cd` outside via the
 *      script body. (We don't pass user-supplied cwd.)
 *   3. Per-call timeout (default 30s, hard cap 5 min). Long-running processes
 *      get SIGKILL'd; the tool result reports `killed: true, exitCode: 137`.
 *   4. stdout / stderr byte caps to bound the model context. Exceeding them
 *      also triggers SIGKILL.
 *
 * Output is returned as JSON: {exitCode, stdout, stderr, durationMs, killed}.
 */

import { spawn } from "node:child_process";
import { getSandboxRoot } from "./sandbox.js";
import { isBlocked } from "./blocklist.js";
import type { ToolApprovalMode } from "./approval.js";
import type { ToolDefinition } from "../tools.js";

/** Context passed to every tool's `execute` so per-tool gating is mode-aware. */
export interface ToolExecContext {
  permissionMode: ToolApprovalMode;
}

const DEFAULT_TIMEOUT_MS = Number(process.env.TOOL_EXEC_TIMEOUT_MS ?? 30_000);
const HARD_TIMEOUT_CAP_MS = 5 * 60_000;
const STDOUT_CAP = 1_000_000;
const STDERR_CAP = 256_000;

const isWin = process.platform === "win32";
const SHELL_NAME = isWin ? "cmd.exe" : "/bin/sh";
const SHELL_FLAG = isWin ? "/d /s /c" : "-c";
const PLATFORM_LABEL = isWin
  ? "Windows (cmd.exe — use `dir`, `del`, `type`, `copy`, `move`, `powershell`)"
  : process.platform === "darwin"
    ? "macOS (POSIX shell — use `ls`, `cat`, `rm`, `cp`, `mv`)"
    : "Linux (POSIX shell — use `ls`, `cat`, `rm`, `cp`, `mv`)";
const SANDBOX_DESCRIPTION_LINE = `Sandbox cwd: ${getSandboxRoot()}`;

const execCommandTool: ToolDefinition = {
  name: "exec_command",
  description:
    `Run a shell command in the sandbox root. Returns JSON {exitCode, stdout, stderr, durationMs, killed}. Use short, idempotent commands. ` +
    `Destructive patterns (rm -rf /, sudo, mkfs, curl|sh, …) are blocked in safe and accept-edits modes; bypass opts out. ` +
    `**Platform: ${PLATFORM_LABEL}. Shell: ${SHELL_NAME}. ${SANDBOX_DESCRIPTION_LINE}.** ` +
    `Pick platform-appropriate commands — e.g. \`dir\` / \`del\` / \`type\` / \`powershell -Command "Remove-Item …"\` on Windows; ` +
    `\`ls\` / \`cat\` / \`rm\` / \`sh -c\` on Linux/macOS.`,
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description:
          `Shell command line. Runs through ${SHELL_NAME} on ${process.platform}.`,
      },
      timeout_ms: {
        type: "number",
        description: "Override the default 30s timeout. Min 1s, max 5 min.",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  preview: (args) => {
    const cmd = typeof args.command === "string" ? args.command : "";
    const tmo =
      typeof args.timeout_ms === "number"
        ? `   (timeout ${args.timeout_ms}ms)`
        : "";
    return `$ ${cmd}${tmo}`;
  },
  execute: async (args, ctx) => {
    const command = String(args.command ?? "").trim();
    if (!command) {
      return JSON.stringify({ exitCode: 1, stdout: "", stderr: "command is required", durationMs: 0, killed: false });
    }
    // Blocklist runs in safe + accept-edits modes. Bypass opts out of all
    // safety; the user has explicitly accepted the risk.
    const mode: ToolApprovalMode = ctx?.permissionMode ?? "safe";
    const block = isBlocked(command, mode);
    if (block) {
      return JSON.stringify({
        exitCode: 137,
        stdout: "",
        stderr: `blocked by safety rule: ${block}`,
        durationMs: 0,
        killed: true,
      });
    }
    const timeoutMs = Math.min(
      Math.max(Number(args.timeout_ms ?? DEFAULT_TIMEOUT_MS), 1_000),
      HARD_TIMEOUT_CAP_MS,
    );
    return await runCommand(command, timeoutMs);
  },
};

function runCommand(command: string, timeoutMs: number): Promise<string> {
  const isWin = process.platform === "win32";
  const shell = isWin ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
  const flag = isWin ? "/d /s /c" : "-c";

  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = "";
    let stderr = "";
    let killed = false;

    // `detached: true` puts the child into its own process group so we
    // can SIGKILL the group on timeout — without this, `bash -c "python &"`
    // orphans the Python child and it keeps running after we report
    // completion. On Windows, detached puts the child into a job; we
    // additionally kill via `taskkill /T` below for the same reason.
    const child = spawn(shell, [flag, command], {
      cwd: getSandboxRoot(),
      env: process.env,
      windowsHide: true,
      detached: !isWin,
    }) as ReturnType<typeof spawn>;

    const killGroup = () => {
      try {
        if (isWin) {
          // /T = terminate tree, /F = force. Falls back gracefully.
          require("node:child_process").spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
        } else if (child.pid) {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {
        // ignore — group may already be dead.
      }
    };

    const timer = setTimeout(() => {
      killed = true;
      killGroup();
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > STDOUT_CAP) {
        stdout = stdout.slice(0, STDOUT_CAP) + "\n[truncated; stdout exceeded 1 MiB]";
        killed = true;
        killGroup();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > STDERR_CAP) {
        stderr = stderr.slice(0, STDERR_CAP) + "\n[truncated; stderr exceeded 256 KiB]";
        killed = true;
        killGroup();
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve(JSON.stringify({
        exitCode: 1,
        stdout,
        stderr: stderr + `\nspawn error: ${err.message}`,
        durationMs: Date.now() - start,
        killed: false,
      }));
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      const exitCode = code ?? (signal === "SIGKILL" ? 137 : 1);
      resolve(JSON.stringify({
        exitCode,
        stdout,
        stderr,
        durationMs,
        killed,
      }));
    });
  });
}

export const execTools: ToolDefinition[] = [execCommandTool];
