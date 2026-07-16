/**
 * In-flight approval queue. The agent loop creates a Promise for each tool
 * call that needs approval, stores the resolve callback here, and awaits it.
 *
 * The HTTP handler `POST /api/chat/approval/:id` looks up the id and calls
 * `resolveApproval()` to unblock the agent loop.
 *
 * Lifecycle:
 *   - One Promise per approval id, registered just before the SSE event is
 *     sent.
 *   - Resolved by `resolveApproval()` from the HTTP handler, or by the
 *     `signal.aborted` listener that auto-denies when the chat is stopped.
 *   - Entries are deleted from the map on resolve to keep state tight.
 *
 * The map is module-scoped (per-process). For a multi-worker deployment,
 * swap to Redis; the call site stays the same.
 */

import type { ApprovalDecision, ToolApprovalMode } from "./tools/approval.js";

interface Pending {
  resolve: (decision: ApprovalDecision) => void;
  /** The mode the agent claimed it was in when it registered the approval. */
  mode: ToolApprovalMode;
  /** Timer id that auto-denies after APPROVAL_TTL_MS, so an abandoned
   *  dialog doesn'\''t sit in the map forever. */
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();

/** Five minutes is generous — a real dialog resolves in seconds — but long
 *  enough that a user who walks away from the keyboard isn'\''t surprised by
 *  a denial. Overridable for tests. */
const APPROVAL_TTL_MS = Number(process.env.APPROVAL_TTL_MS ?? 5 * 60_000);

/**
 * Register a new approval and return a Promise that resolves to the user'\''s
 * decision. If the abort signal fires before the user responds, the Promise
 * resolves to `"deny"` (fail-closed) so the chat can exit cleanly.
 */
export function awaitApproval(
  id: string,
  mode: ToolApprovalMode,
  signal: AbortSignal,
): Promise<ApprovalDecision> {
  return new Promise<ApprovalDecision>((resolve) => {
    const settle = (decision: ApprovalDecision) => {
      const still = pending.get(id);
      if (!still) return;
      pending.delete(id);
      clearTimeout(still.timer);
      still.resolve(decision);
    };
    const timer = setTimeout(() => settle("deny"), APPROVAL_TTL_MS);
    // Severity-0 fix: store the Promise'\''s own `resolve` on the entry so the
    // HTTP handler (resolveApproval) actually settles the awaiting Promise.
    // Previously this was `resolve: settle`, which made `settle` callable
    // but never actually settled the awaiter because `resolve` was a
    // self-reference.
    const entry: Pending = { resolve, mode, timer };
    pending.set(id, entry);

    const onAbort = () => settle("deny");
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Resolve a pending approval. Returns `true` if found and resolved,
 * `false` if no such id was pending (already resolved, or never registered).
 */
export function resolveApproval(
  id: string,
  decision: ApprovalDecision,
): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  clearTimeout(entry.timer);
  entry.resolve(decision);
  return true;
}

/** Test-only / debug: how many approvals are in flight? */
export function _pendingCount(): number {
  return pending.size;
}
