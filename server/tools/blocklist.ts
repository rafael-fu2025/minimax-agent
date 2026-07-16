/**
 * Exec-command blocklist. Default list catches the obvious destructive
 * patterns; users can extend via `TOOL_EXEC_BLOCKLIST` (newline-separated
 * regexes, case-insensitive).
 *
 * Blocklist + sandbox root is the chosen safety model. Allowlist of "safe
 * commands" would block too much and make the tool useless.
 *
 * In `bypass` permission mode the user has explicitly opted out of all
 * safety, so the blocklist yields. `safe` and `accept-edits` keep the
 * blocklist on as a last line of defense.
 */

import type { ToolApprovalMode } from "./approval.js";

const DEFAULT: RegExp[] = [
  // rm -rf / (and variants with --force, with wildcards)
  /\brm\s+(-\s*[a-zA-Z]*[fF][a-zA-Z]*\s+|--force\s+)*\/(\s|$|\*)/,
  // Classic fork bomb
  /:\(\s*\)\s*\{[^}]*\|[^}]*&\s*\}\s*;\s*:/,
  // Disk / filesystem reformat
  /\bmkfs(\.[a-z0-9]+)?\b/,
  // dd to raw disk
  /\bdd\b[^|;&]*\bof=\/dev\/(sd|nvme|hd|xvd|vd)/,
  // System power / runlevel
  /^\s*(shutdown|reboot|halt|poweroff)\b/,
  /^\s*init\s+0\b/,
  // Privilege escalation
  /\bsudo\b/,
  // Curl / wget piped into a shell
  /\bcurl\b[^|;&]*\|\s*(sh|bash|zsh|ksh)\b/,
  /\bwget\b[^|;&]*\|\s*(sh|bash|zsh|ksh)\b/,
  // rm writing outside cwd without explicit confirmation: NOT in the list,
  // because we already cap writes via the sandbox root.
];

const EXTRA: RegExp[] = (process.env.TOOL_EXEC_BLOCKLIST ?? "")
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean)
  .map((pat) => {
    try {
      return new RegExp(pat, "i");
    } catch {
      console.warn(`[exec-blocklist] skipping invalid regex: ${pat}`);
      return null;
    }
  })
  .filter((r): r is RegExp => r !== null);

const ALL: RegExp[] = [...DEFAULT, ...EXTRA];

/**
 * Returns the label of the first matching pattern, or null if clean.
 * The label is human-readable so the tool can echo *which* pattern matched.
 *
 * In `bypass` mode the blocklist is skipped entirely — the user has
 * explicitly opted out of all safety. `safe` and `accept-edits` keep the
 * blocklist on as a defense-in-depth (in case the approval dialog is
 * missed or a tool result slips through).
 */
export function isBlocked(
  command: string,
  mode: ToolApprovalMode = "safe",
): string | null {
  if (mode === "bypass") return null;
  for (const re of ALL) {
    if (re.test(command)) {
      return re.source.length > 80 ? re.source.slice(0, 77) + "..." : re.source;
    }
  }
  return null;
}
