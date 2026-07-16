/**
 * Vitest setup — runs once per test file before any module under test is
 * imported. We need a working `localStorage` shim because:
 *
 *   1. `tests` runs with `environment: "node"` (so we can test server and
 *      hooks side by side without pulling in jsdom).
 *   2. The hook tests (`tests/hooks/*.test.ts`) invoke React components
 *      that read/write `localStorage`. The shim below mirrors the parts of
 *      the Storage API the hooks touch, plus the storage event surface.
 *
 * The shim is intentionally tiny: just enough to make the hooks run. We do
 * NOT call `globalThis.crypto.randomUUID`; the hooks do not depend on it.
 */
import { afterEach, beforeEach } from "vitest";

class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

beforeEach(() => {
  // Vitest node env exposes localStorage as a non-writable getter that
  // lacks clear/removeItem. Replace it via defineProperty so we can
  // install a working in-memory shim. `configurable: true` matters
  // because Vitest re-uses the same globalThis across tests.
  Object.defineProperty(globalThis, "localStorage", {
    value: new MemoryStorage(),
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  const g = globalThis as unknown as { localStorage?: Storage };
  if (g.localStorage && g.localStorage.clear) g.localStorage.clear();
});