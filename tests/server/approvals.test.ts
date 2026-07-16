/**
 * `awaitApproval` — covers the in-memory approval queue:
 *   1. Resolves to `"deny"` when the abort signal fires.
 *   2. Resolves to the value passed via `resolveApproval()`.
 *   3. Resolves to `"deny"` after the TTL expires (configurable so the
 *      test can use a short value).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("awaitApproval", () => {
  let mod: typeof import("../../server/approvals.js");

  beforeEach(async () => {
    // Set the TTL to 50ms via the documented env override. We re-import
    // the module each test so the env var takes effect.
    process.env.APPROVAL_TTL_MS = "50";
    vi.resetModules();
    mod = await import("../../server/approvals.js");
  });

  afterEach(() => {
    delete process.env.APPROVAL_TTL_MS;
  });

  it("resolves to 'deny' when the abort signal fires", async () => {
    const ac = new AbortController();
    const promise = mod.awaitApproval("a1", "safe", ac.signal);
    ac.abort();
    await expect(promise).resolves.toBe("deny");
  });

  it("resolves with the decision when resolveApproval is called", async () => {
    const ac = new AbortController();
    const promise = mod.awaitApproval("a2", "safe", ac.signal);
    const ok = mod.resolveApproval("a2", "allow");
    expect(ok).toBe(true);
    await expect(promise).resolves.toBe("allow");
  });

  it("returns false from resolveApproval for an unknown id", () => {
    expect(mod.resolveApproval("never-registered", "allow")).toBe(false);
  });

  it("auto-denies after the TTL elapses", async () => {
    const ac = new AbortController();
    const start = Date.now();
    const decision = await mod.awaitApproval("a3", "safe", ac.signal);
    const elapsed = Date.now() - start;
    // TTL was 50ms; allow generous slack for CI jitter.
    expect(decision).toBe("deny");
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(2_000);
  });

  it("removes the entry after resolve so it can't be re-resolved", async () => {
    const ac = new AbortController();
    const promise = mod.awaitApproval("a4", "safe", ac.signal);
    mod.resolveApproval("a4", "allow");
    await expect(promise).resolves.toBe("allow");
    // Second call should be a no-op returning false.
    expect(mod.resolveApproval("a4", "deny")).toBe(false);
  });
});