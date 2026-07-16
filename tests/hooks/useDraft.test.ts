/**
 * Unit tests for the localStorage helpers behind `useDraft`. The hook
 * itself depends on React state; the pure read/write layer is the part
 * that can actually misbehave (quotas, missing storage, mismatched keys).
 */
import { describe, expect, it } from "vitest";
import {
  KEY_PREFIX,
  clearAllDrafts,
  readDraft,
  writeDraft,
} from "../../src/hooks/useDraft";

describe("readDraft", () => {
  it("returns an empty string when nothing was written", () => {
    expect(readDraft("conv-1")).toBe("");
  });

  it("returns the previously-written value for the same id", () => {
    writeDraft("conv-1", "hello world");
    expect(readDraft("conv-1")).toBe("hello world");
  });

  it("scopes by conversation id (no cross-talk)", () => {
    writeDraft("conv-1", "alpha");
    writeDraft("conv-2", "beta");
    expect(readDraft("conv-1")).toBe("alpha");
    expect(readDraft("conv-2")).toBe("beta");
  });

  it("returns empty string when localStorage is unavailable", () => {
    // Pretend the Storage API is gone (private mode, sandboxed iframe).
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      value: undefined as unknown as Storage,
      configurable: true,
      writable: true,
    });
    try {
      expect(readDraft("any")).toBe("");
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        value: original,
        configurable: true,
        writable: true,
      });
    }
  });
});

describe("writeDraft", () => {
  it("stores under the namespaced key", () => {
    writeDraft("conv-1", "draft text");
    expect(localStorage.getItem(KEY_PREFIX + "conv-1")).toBe("draft text");
  });

  it("removes the key when value is empty (so the slice is clean)", () => {
    writeDraft("conv-1", "draft text");
    writeDraft("conv-1", "");
    expect(localStorage.getItem(KEY_PREFIX + "conv-1")).toBeNull();
    expect(readDraft("conv-1")).toBe("");
  });

  it("overwrites a previous value for the same id", () => {
    writeDraft("conv-1", "first");
    writeDraft("conv-1", "second");
    expect(readDraft("conv-1")).toBe("second");
  });

  it("does not throw when localStorage is unavailable", () => {
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      value: undefined as unknown as Storage,
      configurable: true,
      writable: true,
    });
    try {
      expect(() => writeDraft("conv-1", "text")).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        value: original,
        configurable: true,
        writable: true,
      });
    }
  });
});

describe("clearAllDrafts", () => {
  it("removes every key under the prefix", () => {
    writeDraft("a", "1");
    writeDraft("b", "2");
    writeDraft("c", "3");
    // A non-draft key that must survive.
    localStorage.setItem("unrelated", "keep-me");
    const removed = clearAllDrafts();
    expect(removed).toBe(3);
    expect(readDraft("a")).toBe("");
    expect(readDraft("b")).toBe("");
    expect(readDraft("c")).toBe("");
    expect(localStorage.getItem("unrelated")).toBe("keep-me");
  });

  it("returns 0 when nothing to clear", () => {
    expect(clearAllDrafts()).toBe(0);
  });

  it("returns 0 when localStorage is unavailable", () => {
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      value: undefined as unknown as Storage,
      configurable: true,
      writable: true,
    });
    try {
      expect(clearAllDrafts()).toBe(0);
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        value: original,
        configurable: true,
        writable: true,
      });
    }
  });
});