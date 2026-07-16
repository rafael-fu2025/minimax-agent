/**
 * `safePersistence` — wraps every hook so failures are caught and logged.
 * Verified invariants:
 *   1. A throwing hook does not propagate to the caller.
 *   2. The wrapper logs to `console.warn` (with the `[persistence]` tag).
 *   3. Non-throwing hooks pass through (the wrapper awaits them).
 *   4. The `safeMemory` wrapper has the same contract for memory hooks.
 */
import { describe, expect, it, vi } from "vitest";

describe("safePersistence", () => {
  it("swallows a throwing onUserMessage and logs a warning", async () => {
    const { safePersistence } = await import("../../server/persistence.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hooks = safePersistence({
      onUserMessage: vi.fn(async () => {
        throw new Error("DB unreachable");
      }),
      onAssistantTurn: vi.fn(async () => {}),
      onToolResult: vi.fn(async () => {}),
      onError: vi.fn(async () => {}),
    });
    await expect(hooks.onUserMessage({ conversationId: "c1", content: "hi" })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "[persistence] onUserMessage failed:",
      expect.stringContaining("DB unreachable"),
    );
    warn.mockRestore();
  });

  it("passes through when the hook resolves", async () => {
    const { safePersistence } = await import("../../server/persistence.js");
    const inner = {
      onUserMessage: vi.fn(async () => "ok"),
      onAssistantTurn: vi.fn(async () => {}),
      onToolResult: vi.fn(async () => {}),
      onError: vi.fn(async () => {}),
    };
    const hooks = safePersistence(inner);
    await hooks.onAssistantTurn({
      conversationId: "c2",
      content: "reply",
      toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    });
    expect(inner.onAssistantTurn).toHaveBeenCalledOnce();
  });

  it("safeMemory swallows a throwing onMessageIndexed", async () => {
    const { safeMemory } = await import("../../server/persistence.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hooks = safeMemory({
      onMessageIndexed: vi.fn(async () => {
        throw new Error("vector store down");
      }),
    });
    await expect(
      hooks.onMessageIndexed({
        conversationId: "c3",
        messageId: 1n,
        role: "user",
        content: "hi",
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "[memory] onMessageIndexed failed:",
      expect.stringContaining("vector store down"),
    );
    warn.mockRestore();
  });

  it("NOOP_PERSISTENCE and NOOP_MEMORY are defined", async () => {
    const mod = await import("../../server/persistence.js");
    expect(typeof mod.NOOP_PERSISTENCE.onUserMessage).toBe("function");
    expect(typeof mod.NOOP_MEMORY.onMessageIndexed).toBe("function");
    // Calling them must not throw.
    await expect(mod.NOOP_PERSISTENCE.onUserMessage({ conversationId: "x", content: "" })).resolves.toBeUndefined();
    await expect(
      mod.NOOP_MEMORY.onMessageIndexed({
        conversationId: "x",
        messageId: 1n,
        role: "user",
        content: "",
      }),
    ).resolves.toBeUndefined();
  });
});