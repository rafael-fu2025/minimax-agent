/**
 * Permission-mode policy.
 *
 * The server is stateless with respect to the agent's permission mode — the
 * client tells the server which mode is in effect on every `/api/chat`
 * request, and the server uses it to decide which tools require approval
 * before they run.
 *
 * Mode semantics:
 *   - `safe`         — prompt before `exec_command` AND `write_file`.
 *   - `accept-edits` — auto-approve `write_file`; prompt for `exec_command`.
 *   - `bypass`       — never prompt (everything runs as today).
 *
 * Read-only tools (read_file, list_dir, search_files, get_current_time,
 * calculate, MCP web_search, MCP understand_image, …) never prompt.
 */

import type { ToolDefinition } from "../tools.js";

export type ToolApprovalMode = "safe" | "accept-edits" | "bypass";

export const DEFAULT_APPROVAL_MODE: ToolApprovalMode = "safe";

export const APPROVAL_MODES: readonly ToolApprovalMode[] = [
  "safe",
  "accept-edits",
  "bypass",
];

export function parseApprovalMode(value: unknown): ToolApprovalMode {
  if (value === "safe" || value === "accept-edits" || value === "bypass") {
    return value;
  }
  return DEFAULT_APPROVAL_MODE;
}

export type ApprovalDecision = "allow" | "deny";

/** Tools that mutate files inside the sandbox. Auto-approved in `accept-edits`. */
const FILE_MUTATIONS = new Set<string>([
  "write_file",
  "delete_file",
  "move_file",
  "create_directory",
  "patch_file",
  "format_code",
  "archive_zip",
  "archive_unzip",
]);

/** Tools that can affect the world outside the sandbox. Prompt in BOTH `safe` and `accept-edits`. */
const HIGH_RISK_MUTATIONS = new Set<string>([
  "exec_command",
  "run_python",
  "image_generate",
  "kill_process",
  "schedule_task",
  "transcribe_audio",
]);

/**
 * Decision table for whether a tool execution needs explicit user approval
 * before running.
 *
 *   tool           | safe | accept-edits | bypass
 *   ---------------+------+--------------+--------
 *   read_file      |  no  |      no      |   no
 *   write_file     | YES  |      no      |   no
 *   delete_file    | YES  |      no      |   no
 *   move_file      | YES  |      no      |   no
 *   ...
 *   exec_command   | YES  |     YES      |   no
 *   run_python     | YES  |     YES      |   no
 *   image_generate | YES  |     YES      |   no
 *   kill_process   | YES  |     YES      |   no
 *   anything else  |  no  |      no      |   no
 */
export function requiresApproval(
  toolName: string,
  mode: ToolApprovalMode,
): boolean {
  if (mode === "bypass") return false;
  if (HIGH_RISK_MUTATIONS.has(toolName)) return true; // prompt in safe AND accept-edits
  if (!FILE_MUTATIONS.has(toolName)) return false; // read-only
  if (mode === "accept-edits") return false; // file edits auto-approved
  // mode === "safe"
  return true;
}

/**
 * Build a one-line human-readable preview of the tool call for the approval
 * dialog. Per-tool previews live on the `ToolDefinition.preview` field so
 * adding a new tool no longer requires editing this file. Falls back to
 * pretty-printed JSON if the tool didn't attach a formatter (or if no
 * registry was supplied to look it up).
 */
export function formatToolPreview(
  toolName: string,
  argumentsJson: string,
  tools?: ToolDefinition[],
): string {
  // 1. Try the tool's own preview if we have a registry.
  if (tools) {
    const def = tools.find((t) => t.name === toolName);
    if (def?.preview) {
      let parsed: Record<string, unknown> = {};
      try {
        const parsedRaw = JSON.parse(argumentsJson);
        if (
          parsedRaw !== null &&
          typeof parsedRaw === "object" &&
          !Array.isArray(parsedRaw)
        ) {
          parsed = parsedRaw as Record<string, unknown>;
        }
      } catch {
        // Malformed JSON — return the raw payload so the approval dialog
        // shows what the model actually tried to send, instead of an empty
        // per-tool preview that hides the parse failure.
        return argumentsJson;
      }
      return def.preview(parsed);
    }
  }
  // 2. Generic fallback: pretty-printed JSON, or the raw string if it's
  //    not parseable.
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return argumentsJson;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return argumentsJson;
  }
  return JSON.stringify(parsed, null, 2);
}

