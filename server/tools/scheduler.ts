/**
 * `schedule_task` — register a one-shot or recurring tool call. Tasks are
 * persisted to a JSON file so they survive server restarts. A 60-second
 * tick interval checks for due tasks and dispatches them through `runTool`.
 * High-risk: prompts in BOTH `safe` AND `accept-edits`.
 *
 *   SCHEDULER_DATA_DIR   default points outside the project (see below)
 *   SCHEDULER_TICK_MS    default 60_000 (1 min)
 *
 * The default data dir is derived from `TOOL_SANDBOX_ROOT` if set, falling
 * back to `<homedir>/agent-scheduler`. Storing it inside the project (e.g.
 * `./data`) would cause Vite to full-reload the dev server every time the
 * scheduler rewrites the JSON, so the default deliberately lives outside.
 *
 * `when` formats supported:
 *   - "in 5m"  / "in 2h"  / "in 30s"  — relative
 *   - ISO 8601 timestamp
 *   - "every 5m"           — recurring
 */

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { runTool } from "../tools.js";
import type { ToolDefinition } from "../tools.js";

interface ScheduledTask {
  id: string;
  tool: string;
  args: string;
  nextRunAt: string;
  recurrence?: string;
  createdAt: string;
  confirm: boolean;
}

const STORAGE_FILE = "scheduler.json";
const TICK_MS_DEFAULT = 60_000;

/**
 * Default location for `scheduler.json`. We deliberately pick a path
 * outside the project tree so the periodic rewrites don't reach Vite's
 * file-watcher and trigger a dev-server full-reload. Two fallbacks:
 *   1. `<TOOL_SANDBOX_ROOT>/data` (keeps everything in one place)
 *   2. `<homedir>/agent-scheduler` (last-resort, never the cwd)
 */
function defaultStorageDir(): string {
  if (process.env.TOOL_SANDBOX_ROOT && process.env.TOOL_SANDBOX_ROOT.trim().length > 0) {
    return join(process.env.TOOL_SANDBOX_ROOT, "data");
  }
  try {
    return join(homedir(), "agent-scheduler");
  } catch {
    return join(process.cwd(), ".agent-scheduler");
  }
}

function storagePath(): string {
  const dir = process.env.SCHEDULER_DATA_DIR ?? defaultStorageDir();
  return join(dir, STORAGE_FILE);
}

async function loadTasks(): Promise<ScheduledTask[]> {
  try {
    const raw = await readFile(storagePath(), "utf8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr as ScheduledTask[];
    return [];
  } catch {
    return [];
  }
}

async function saveTasks(tasks: ScheduledTask[]): Promise<void> {
  const path = storagePath();
  await mkdir(dirname(path), { recursive: true });
  // Atomic write: write to a tmp file in the same directory, then rename.
  // `rename` is atomic on POSIX and best-effort on Windows; either way it
  // protects concurrent readers from reading a half-written JSON file.
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(tasks, null, 2), "utf8");
  await rename(tmp, path);
}

function parseWhen(input: string, now: Date = new Date()): { next: Date; recurrence?: string } {
  const s = input.trim();
  // "in 5m" / "in 2h" / "in 30s"
  const rel = s.match(/^in\s+(\d+)\s*(s|m|h)$/i);
  if (rel) {
    const n = Number(rel[1]);
    const ms = rel[2].toLowerCase() === "s" ? n * 1000
      : rel[2].toLowerCase() === "m" ? n * 60_000
      : n * 3_600_000;
    return { next: new Date(now.getTime() + ms) };
  }
  // "every 5m"
  const every = s.match(/^every\s+(\d+)\s*(s|m|h)$/i);
  if (every) {
    const n = Number(every[1]);
    const ms = every[2].toLowerCase() === "s" ? n * 1000
      : every[2].toLowerCase() === "m" ? n * 60_000
      : n * 3_600_000;
    return { next: new Date(now.getTime() + ms), recurrence: s };
  }
  // ISO timestamp
  const iso = new Date(s);
  if (!isNaN(iso.getTime())) return { next: iso };
  throw new Error(`unrecognized 'when' format: ${input}`);
}

const scheduleTaskTool: ToolDefinition = {
  name: "schedule_task",
  description:
    "Register a one-shot or recurring tool call. `when` accepts: 'in <n>s|m|h' (relative), 'every <n>s|m|h' (recurring), or an ISO 8601 timestamp. `tool` is the tool name (e.g. 'exec_command', 'run_python'); `args` is a JSON string passed as the tool's argument. `confirm: true` is required to schedule a tool that prompts in `accept-edits` (e.g. `kill_process`, `run_python`). Tasks are persisted to a JSON file and survive server restarts. Returns the assigned task id. Mutating in spirit (can spawn work); prompts in BOTH `safe` AND `accept-edits`.",
  parameters: {
    type: "object",
    properties: {
      when: { type: "string", description: "When to run. Examples: 'in 5m', 'in 1h', 'every 30m', '2026-07-07T09:00:00Z'." },
      tool: { type: "string", description: "Tool name to invoke." },
      args: { type: "string", description: "JSON-string of tool arguments." },
      confirm: { type: "boolean", description: "Set true to schedule a tool that prompts in accept-edits." },
    },
    required: ["when", "tool", "args"],
    additionalProperties: false,
  },
  preview: (args) =>
    `schedule ${typeof args.tool === "string" ? args.tool : "?"} at ${
      typeof args.when === "string" ? args.when : "?"
    }`,
  execute: async (args) => {
    try {
      const { next, recurrence } = parseWhen(String(args.when ?? ""));
      const tool = String(args.tool ?? "");
      const toolArgs = String(args.args ?? "");
      const confirm = Boolean(args.confirm);
      const task: ScheduledTask = {
        id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        tool,
        args: toolArgs,
        nextRunAt: next.toISOString(),
        recurrence,
        createdAt: new Date().toISOString(),
        confirm,
      };
      const tasks = await loadTasks();
      tasks.push(task);
      await saveTasks(tasks);
      return `Scheduled ${task.id} at ${task.nextRunAt}${recurrence ? ` (recurring ${recurrence})` : ""} for tool ${tool}`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const schedulerTools: ToolDefinition[] = [scheduleTaskTool];

/* -------------------------------------------------------------------------- */
/* Tick loop — exported separately so server/index.ts can start it once      */
/* -------------------------------------------------------------------------- */

let tickHandle: NodeJS.Timeout | null = null;
let tickInProgress = false;

export async function runSchedulerTick(): Promise<void> {
  // Re-entrancy guard: if a previous tick is still running (e.g. a slow
  // tool took longer than the tick interval), skip this one to avoid
  // firing the same task twice. The next setInterval will retry.
  if (tickInProgress) return;
  tickInProgress = true;
  try {
    await runSchedulerTickInner();
  } finally {
    tickInProgress = false;
  }
}

async function runSchedulerTickInner(): Promise<void> {
  const tasks = await loadTasks();
  const now = new Date();
  const remaining: ScheduledTask[] = [];
  let fired = 0;
  for (const t of tasks) {
    if (new Date(t.nextRunAt) <= now) {
      // Fire the tool.
      try {
        await runTool(t.tool, t.args);
        fired++;
      } catch (err) {
        console.warn(`[scheduler] task ${t.id} (${t.tool}) failed:`, err);
      }
      // If recurring, compute the next run. Otherwise drop it.
      if (t.recurrence) {
        const { next } = parseWhen(t.recurrence, now);
        remaining.push({ ...t, nextRunAt: next.toISOString() });
      }
    } else {
      remaining.push(t);
    }
  }
  if (fired > 0) {
    await saveTasks(remaining);
  }
}

export function startScheduler(): void {
  if (tickHandle) return;
  const interval = Number(process.env.SCHEDULER_TICK_MS ?? TICK_MS_DEFAULT);
  tickHandle = setInterval(() => {
    runSchedulerTick().catch((err) => {
      console.warn("[scheduler] tick failed:", err);
    });
  }, interval);
  console.log(`[scheduler] tick every ${interval}ms, storage ${storagePath()}`);
}

export function stopScheduler(): void {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
}

