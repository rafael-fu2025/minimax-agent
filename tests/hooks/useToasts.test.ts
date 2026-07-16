/**
 * Unit tests for the pure helpers backing `useToasts`. We avoid spinning up
 * a React renderer on purpose: the hook is a thin wrapper around two
 * functions we can drive directly. The hook itself is exercised by the
 * toast-driven UI in the manual smoke flow; these tests pin the rules.
 */
import { describe, expect, it } from "vitest";
import {
  enqueueToast,
  dismissToast,
  type Toast,
} from "../../src/hooks/useToasts";

const t = (id: string, overrides: Partial<Toast> = {}): Toast => ({
  id,
  variant: "info",
  message: id,
  createdAt: 0,
  expiresAt: 0,
  ...overrides,
});

describe("enqueueToast", () => {
  it("appends to an empty list", () => {
    expect(enqueueToast([], t("a"), 5)).toEqual([t("a")]);
  });

  it("preserves order when under the cap", () => {
    const list = [t("a"), t("b")];
    expect(enqueueToast(list, t("c"), 5)).toEqual([t("a"), t("b"), t("c")]);
  });

  it("evicts the oldest toast when over the cap (FIFO)", () => {
    const list = [t("a"), t("b"), t("c")];
    const next = enqueueToast(list, t("d"), 3);
    expect(next.map((x) => x.id)).toEqual(["b", "c", "d"]);
  });

  it("caps aggressively on a tiny max", () => {
    const list = [t("a"), t("b"), t("c"), t("d"), t("e")];
    const next = enqueueToast(list, t("f"), 1);
    expect(next).toEqual([t("f")]);
  });

  it("treats max <= 0 as a single-slot overflow", () => {
    // Defensive: callers should never pass 0, but if they do the newest
    // toast is the only thing visible.
    const next = enqueueToast([t("a"), t("b")], t("c"), 0);
    expect(next).toEqual([t("c")]);
  });

  it("does not mutate the input list", () => {
    const list = [t("a"), t("b")];
    const snapshot = [...list];
    enqueueToast(list, t("c"), 5);
    expect(list).toEqual(snapshot);
  });
});

describe("dismissToast", () => {
  it("removes the matching id", () => {
    const list = [t("a"), t("b"), t("c")];
    expect(dismissToast(list, "b").map((x) => x.id)).toEqual(["a", "c"]);
  });

  it("returns the same array shape when id is unknown", () => {
    const list = [t("a"), t("b")];
    const next = dismissToast(list, "z");
    expect(next.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("handles an empty list without crashing", () => {
    expect(dismissToast([], "x")).toEqual([]);
  });
});