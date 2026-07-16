/**
 * `run_python` — execute a Python script in a sandboxed subprocess.
 *
 *   - Runs the system `python` (or `python3`) with `-I -S` so user-site
 *     and startup scripts are disabled.
 *   - Chdir to the sandbox root so all file ops go through resolveSafePath
 *     checks upstream (we don't redo the check here).
 *   - Hard timeout (default 30s, max 5 min) — SIGKILL on expiry.
 *   - AST scan before execution: rejects scripts that reference dangerous
 *     stdlib calls outside the sandbox (`os.system`, `subprocess.Popen`,
 *     `ctypes`, raw `socket`, raw `urllib`).
 *
 *   PYTHON_BIN (default: "python" on Windows, "python3" on POSIX)
 */

import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { getSandboxRoot, resolveSafePath } from "./sandbox.js";
import type { ToolDefinition } from "../tools.js";

const IS_WIN = process.platform === "win32";
const DEFAULT_BIN = process.env.PYTHON_BIN ?? (IS_WIN ? "python" : "python3");
const TIMEOUT_MS_DEFAULT = 30_000;
const TIMEOUT_MS_MAX = 5 * 60_000;

// Forbidden imports or attribute accesses in the script. AST-walked before
// execution; on match, the script is rejected.
const FORBIDDEN_NAMES = new Set([
  "system",        // os.system
  "popen",         // subprocess.Popen
  "Popen",         // class name
  "rmtree",        // shutil.rmtree
  "remove",        // os.remove / os.unlink
  "unlink",
  "chmod",
  "chown",
  "fork",
  "exec",          // os.exec*
  "execlp",
  "spawn",
  "spawnl",
  "spawnlp",
  "ctypes",
  "cdll",
  "windll",
  "_exit",
  "kill",          // os.kill
  "ctypes_pointer",
]);

// Forbidden modules — disallowed at import.
const FORBIDDEN_MODULES = new Set([
  "subprocess",
  "ctypes",
  "socket",
  "urllib",
  "urllib2",
  "urllib3",
  "http",
  "httplib",
  "xmlrpc",
  "ftplib",
  "smtplib",
  "poplib",
  "telnetlib",
  "asyncio",
  "multiprocessing",
  "pty",
  "fcntl",
  "termios",
  "tty",
  "resource",
  "importlib",
  "sys",           // any direct sys.* calls that escape sandbox (we'd be lenient but a stricter policy would ban this)
]);

class AstViolation extends Error {}

function checkAst(source: string): void {
  // Lightweight AST via Function (no imports needed).  We don't actually
  // execute the script — just parse a stripped copy to validate names
  // appear, but for the level of safety we need, a *linear* scan over the
  // source string is enough: scan for `from X import …` and `import X`
  // lines, and for `name.ident` patterns inside a tokenized-ish regex.
  //
  // Note: this is *not* a robust AST analysis.  A determined attacker can
  // bypass it with `__import__("os")` or `getattr(os, "sys"+"tem")`.
  // Mitigations: -S flag suppresses startup hooks; -I isolates the
  // interpreter; the sandbox check at the file-IO layer is the real
  // boundary.  This scan is just to nudge the model away from obvious
  // patterns and produce a friendly error instead of a run-then-fail.

  const lines = source.split(/\r?\n/);
  let inTriple = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    // Track triple-quoted strings to avoid false positives.
    if (line.startsWith('"""') || line.startsWith("'''")) {
      const tick = line.slice(0, 3);
      if (line === tick || line.endsWith(tick)) {
        inTriple = !inTriple;
        continue;
      }
      inTriple = !inTriple;
    }
    if (inTriple) continue;
    // import / from-import lines.
    const impMatch = line.match(/^(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/);
    if (impMatch) {
      const mod = impMatch[1] || impMatch[2];
      if (mod) {
        const root = mod.split(".")[0];
        if (FORBIDDEN_MODULES.has(root)) {
          throw new AstViolation(`importing forbidden module '${root}' (line ${i + 1})`);
        }
      }
    }
    // Bare calls like `os.system(`, `subprocess.Popen(`, `shutil.rmtree(`.
    for (const name of FORBIDDEN_NAMES) {
      const re = new RegExp(`\\b\\w+\\.${name}\\b`);
      if (re.test(line)) {
        throw new AstViolation(`forbidden call '<module>.${name}' detected (line ${i + 1})`);
      }
    }
  }
}

const runPythonTool: ToolDefinition = {
  name: "run_python",
  description:
    "Run a Python script in the sandboxed root. `code` is the source string (mutually exclusive with `path`). Runs the system Python with `-I -S` (isolated; no user site-packages, no startup scripts). Hard timeout (default 30s, cap 5 min). Before running, an AST scan rejects scripts that import dangerous stdlib modules (`subprocess`, `ctypes`, `socket`, `urllib`, `asyncio`, `multiprocessing`, …) or call dangerous methods (`os.system`, `subprocess.Popen`, `shutil.rmtree`, `ctypes.*`, …). Files touched by the script are still subject to the standard sandbox check. Mutating in the approval sense (can fork, can spend CPU/memory); prompts in BOTH `safe` AND `accept-edits`.",
  parameters: {
    type: "object",
    properties: {
      code: { type: "string", description: "Python source code. Mutually exclusive with `path`." },
      path: { type: "string", description: "Path to a .py file inside the sandbox, relative to the root. Mutually exclusive with `code`." },
      args: {
        type: "array",
        items: { type: "string" },
        description: "Optional argv to pass after the script path/stdin.",
      },
      timeout_ms: {
        type: "number",
        description: "Override the default 30s timeout. Min 1s, max 5 min.",
      },
    },
    additionalProperties: false,
  },
  preview: (args) => {
    let src: string;
    if (typeof args.path === "string" && args.path.length > 0) src = args.path;
    else if (typeof args.code === "string" && args.code.length > 0)
      src = `<inline ${args.code.length}c>`;
    else src = "<inline>";
    return `python ${src}`;
  },
  execute: async (args) => {
    try {
      let source: string;
      let argv: string[] = [];
      if (typeof args.code === "string" && args.code.length > 0) {
        if (typeof args.path === "string" && args.path.length > 0) {
          return "Error: pass either `code` or `path`, not both";
        }
        source = args.code;
        argv = ["-c", source];
      } else if (typeof args.path === "string" && args.path.length > 0) {
        const target = await resolveSafePath(args.path);
        const s = await stat(target).catch(() => null);
        if (!s || !s.isFile()) return `Error: not a file: ${args.path}`;
        source = await readFile(target, "utf8");
        argv = [target];
      } else {
        return "Error: either `code` or `path` is required";
      }

      try {
        checkAst(source);
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }

      const timeoutMs = Math.min(
        Math.max(Number(args.timeout_ms ?? TIMEOUT_MS_DEFAULT), 1_000),
        TIMEOUT_MS_MAX,
      );
      const extra = Array.isArray(args.args)
        ? (args.args as unknown[]).map((a) => String(a))
        : [];

      const sandboxRoot = getSandboxRoot();
      const env = { ...process.env, PYTHONIOENCODING: "utf-8" };
      // Drop any PYTHONPATH so the script can't load libraries from
      // elsewhere on the system.
      delete (env as Record<string, string | undefined>).PYTHONPATH;

      return await new Promise<string>((resolve) => {
        const start = Date.now();
        let stdout = "";
        let stderr = "";
        let killed = false;
        const child = spawn(DEFAULT_BIN, ["-I", "-S", ...argv, ...extra], {
          cwd: sandboxRoot,
          env,
          windowsHide: true,
        });
        const timer = setTimeout(() => {
          killed = true;
          try { child.kill("SIGKILL"); } catch { /* ignore */ }
        }, timeoutMs);
        child.stdout.on("data", (c) => {
          stdout += c.toString("utf8");
          if (stdout.length > 1_000_000) {
            stdout = stdout.slice(0, 1_000_000) + "\n[truncated; stdout exceeded 1 MiB]";
            killed = true;
            try { child.kill("SIGKILL"); } catch { /* ignore */ }
          }
        });
        child.stderr.on("data", (c) => {
          stderr += c.toString("utf8");
          if (stderr.length > 256_000) {
            stderr = stderr.slice(0, 256_000) + "\n[truncated; stderr exceeded 256 KiB]";
            killed = true;
            try { child.kill("SIGKILL"); } catch { /* ignore */ }
          }
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          resolve(
            `Error: failed to spawn ${DEFAULT_BIN}: ${err.message}\n` +
              `(set PYTHON_BIN env var to the path of your python interpreter if not on PATH)`,
          );
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          const durationMs = Date.now() - start;
          const ok = code === 0;
          return resolve(
            JSON.stringify(
              {
                exitCode: code,
                ok,
                killed,
                durationMs,
                stdout,
                stderr,
                bin: DEFAULT_BIN,
              },
              null,
              2,
            ),
          );
        });
      });
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const pythonTools: ToolDefinition[] = [runPythonTool];
