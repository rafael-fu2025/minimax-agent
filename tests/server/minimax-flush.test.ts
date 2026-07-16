import { describe, it, expect } from "vitest";
import { isCompleteJson } from "../../server/minimax.js";

describe("isCompleteJson (regression for Severity-0 premature flush)", () => {
  it("returns false for partial nested object", () => {
    // The exact scenario that triggered the original bug: the inner object
    // closed, the old heuristic flushed at this point, but the outer was
    // still incomplete.
    expect(isCompleteJson('{"cfg":{"k":"v"')).toBe(false);
  });
  it("returns true for complete nested object", () => {
    expect(isCompleteJson('{"cfg":{"k":"v"}}')).toBe(true);
  });
  it("returns true for nested array", () => {
    expect(isCompleteJson('{"list":[1,2,3]}')).toBe(true);
  });
  it("returns false while still inside a string literal", () => {
    expect(isCompleteJson('{"k":"partial')).toBe(false);
  });
  it("ignores braces inside string literals", () => {
    // `}` inside the string is inside `"..."` and must not decrement depth;
    // depth drops to 0 only at the final `}` of the outer object — and the
    // helper requires that to also be the last char (no trailing junk).
    expect(isCompleteJson('{"k":"a}b"}')).toBe(true);
    expect(isCompleteJson('{"k":"a}b"}x')).toBe(false);
  });
  it("returns false for empty", () => {
    expect(isCompleteJson("")).toBe(false);
  });
  it("returns true for plain object", () => {
    expect(isCompleteJson('{"a":1}')).toBe(true);
  });
  it("returns false with trailing junk", () => {
    expect(isCompleteJson('{"a":1}x')).toBe(false);
  });
});
