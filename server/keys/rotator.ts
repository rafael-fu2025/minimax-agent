/**
 * MiniMax API key rotation. Round-robin pool with reactive fail-over
 * on 429 / 5xx / network errors. Per-key in-memory rate-limit cooldown
 * (`rateLimitedUntil`) prevents the rotator from hammering a known-dead
 * key. Successful calls reset the consecutive-error counter.
 *
 * Usage:
 *   const result = await rotator.call(async (secret) => {
 *     return await fetch(url, { headers: { Authorization: `Bearer ${secret}` } });
 *   });
 *
 * The function is called with the active key's secret. Throwing is how
 * the function signals a failure; non-throwing is success. The rotator
 * itself is "stateless" outside the cooldown map and cursor, so a
 * server restart resets both without losing data persisted to the
 * `minimax_keys` table.
 */

import { recordError, recordSuccess, loadSources, markRateLimited } from "./index.js";

export interface RotaSource {
  id: string;            // row id (UUID) or "bootstrap-<hash>" for the env-var key
  secret: string;         // the API key value
  isBootstrap: boolean;
  /** Loaded from the DB row; null for the env-var key. */
  row: {
    id: string;
    name: string;
    status: "active" | "disabled";
    rateLimitedUntil: Date | null;
    consecutiveErrors: number;
  } | null;
}

export interface RotaOk<T> {
  ok: true;
  result: T;
  keyId: string;
  keyName: string;
}

export interface RotaErr {
  ok: false;
  error: Error;
}

export type RotaResult<T> = RotaOk<T> | RotaErr;

const RATE_LIMIT_COOLDOWN_MS = 60_000;

export class KeyRotator {
  private sources: RotaSource[] = [];
  private cursor = 0;
  private lastLoaded = 0;
  /** Don't refresh more often than this; the DB rarely changes mid-session. */
  private readonly REFRESH_MIN_INTERVAL_MS = 5_000;

  constructor(private readonly baseUrl: string) {
    // The baseUrl is captured so callers can use the rotator without
    // re-importing the config module.
  }

  /** Reload the source list from the DB + env-var. Called on boot and on demand. */
  async refresh(): Promise<void> {
    this.sources = await loadSources(this.baseUrl);
    this.lastLoaded = Date.now();
  }

  /** True if the source list is non-empty. */
  get hasKeys(): boolean {
    return this.sources.length > 0;
  }

  /**
   * Execute `fn` against a sequence of keys. On 429 / 5xx / network error,
   * mark the failing key as rate-limited for a sliding window and try the
   * next. On any other error (e.g. 400/401/403), throw immediately — those
   * indicate a config problem, not a rate limit.
   *
   * Throws if no key succeeds.
   */
  async call<T>(fn: (secret: string) => Promise<T>): Promise<T> {
    if (Date.now() - this.lastLoaded > this.REFRESH_MIN_INTERVAL_MS) {
      // Best-effort; failures here shouldn't fail the call.
      this.refresh().catch(() => {});
    }
    if (this.sources.length === 0) {
      // First-call init (sources were empty at boot).
      await this.refresh();
      if (this.sources.length === 0) {
        throw new Error("no MiniMax API keys configured");
      }
    }
    const start = this.cursor;
    let lastErr: Error | null = null;
    for (let i = 0; i < this.sources.length; i++) {
      const idx = (start + i) % this.sources.length;
      const src = this.sources[idx];
      if (src.row?.status === "disabled") continue;
      if (src.row?.rateLimitedUntil && src.row.rateLimitedUntil.getTime() > Date.now()) {
        continue;
      }
      try {
        const result = await fn(src.secret);
        // Success — record counters in the background.
        recordSuccess(src.id).catch((err) =>
          console.warn("[keys] recordSuccess failed:", err),
        );
        this.cursor = (idx + 1) % this.sources.length;
        return result;
      } catch (err) {
        const status =
          (err as { status?: number; response?: { status?: number } }).status ??
          (err as { response?: { status?: number } }).response?.status ??
          0;
        const isRetryable = status === 429 || (status >= 500 && status < 600) || status === 0;
        const row = src.row;
        if (isRetryable && row) {
          // Mark the row as rate-limited and continue. Previously this
          // used a dynamic import() inside the hot path; we now hoist
          // it to a top-level import above.
          markRateLimited(row.id, RATE_LIMIT_COOLDOWN_MS, err).catch(
            (e: unknown) =>
              console.warn("[keys] markRateLimited failed:", (e as Error).message),
          );
          row.rateLimitedUntil = new Date(
            Date.now() + RATE_LIMIT_COOLDOWN_MS,
          );
          lastErr = err as Error;
          continue;
        }
        // Non-retryable: record and rethrow.
        if (src.row) {
          recordError(src.row.id, err).catch((e) =>
            console.warn("[keys] recordError failed:", e),
          );
        }
        throw err;
      }
    }
    throw lastErr ?? new Error("all keys failed (rate-limited)");
  }
}

let _instance: KeyRotator | null = null;

/**
 * Get the singleton rotator. The baseUrl is captured once at first call;
 * subsequent calls ignore any extra argument (callers used to pass one,
 * which was always ignored — we keep the parameter optional for back-compat
 * and warn on a mismatch so the silent-loss is loud, not quiet).
 */
/**
 * Get the singleton rotator. `baseUrl` is captured once at first call;
 * subsequent calls ignore any extra argument (callers used to pass one,
 * which was always ignored — we keep the parameter optional for back-compat
 * and warn on a mismatch so the silent-loss is loud, not quiet).
 */
export async function getRotator(baseUrl?: string): Promise<KeyRotator> {
  if (!_instance) {
    // Lazy-import the config so this module stays free of cycles; the
    // caller no longer needs to thread baseUrl through every callsite.
    const { getConfig } = await import("../minimax.js");
    _instance = new KeyRotator(getConfig().baseUrl);
    _instance.refresh().catch((e) => console.warn("[keys] initial refresh failed:", e));
    return _instance;
  }
  if (baseUrl && baseUrl !== (_instance as unknown as { baseUrl: string }).baseUrl) {
    console.warn(
      `[keys] getRotator() called with a different baseUrl after the singleton was created; ignoring.`,
    );
  }
  return _instance;
}


