import { defineConfig } from "vitest/config";

/**
 * Vitest config — runs the unit tests in `tests/`.
 *
 * Tests are colocated under `tests/server/` and `tests/tools/` mirroring
 * the source layout. The `node` environment is used because all server
 * code targets Node 22.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Per-file setup installs the localStorage shim used by the hook
    // tests. Loaded for every file because the cost is trivial and the
    // shim also serves as a clean-storage reset between tests.
    setupFiles: ["./tests/setup.ts"],
    // Keep each test small and fast — under 5s default. CI can override.
    testTimeout: 5000,
    // Surface unhandled rejections as failures instead of warnings.
    dangerouslyIgnoreUnhandledErrors: false,
  },
});