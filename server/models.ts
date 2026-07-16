/**
 * Single source of truth for the MiniMax model registry.
 *
 * The agent loop reads `MODEL_LIMITS` to compute token-budget sidebars; the
 * `/api/models` endpoint reads the same table when it serves limits. The
 * `KNOWN_MODELS` fallback list is shared with the route's hard-coded
 * fallback (used when `/v1/models` is unreachable), so the two never drift.
 */

export const MODEL_LIMITS: Record<
  string,
  { context: number; maxOutput: number }
> = {
  "MiniMax-M3": { context: 1_000_000, maxOutput: 128_000 },
  "MiniMax-M2.7": { context: 204_800, maxOutput: 128_000 },
  "MiniMax-M2.7-highspeed": { context: 204_800, maxOutput: 128_000 },
  "MiniMax-M2.5": { context: 204_800, maxOutput: 128_000 },
  "MiniMax-M2.5-highspeed": { context: 204_800, maxOutput: 128_000 },
  "MiniMax-M2.1": { context: 204_800, maxOutput: 128_000 },
  "MiniMax-M2.1-highspeed": { context: 204_800, maxOutput: 128_000 },
  "MiniMax-M2": { context: 204_800, maxOutput: 128_000 },
};

export function getModelLimits(model?: string | null) {
  if (!model) return undefined;
  return MODEL_LIMITS[model];
}

/** Hard-coded fallback when /v1/models is unreachable. Kept in sync with
 *  `MODEL_LIMITS` above — the `/api/models` route returns the matching
 *  limits for every id in this list. */
export const KNOWN_MODELS: readonly string[] = [
  "MiniMax-M3",
  "MiniMax-M2.7",
  "MiniMax-M2.7-highspeed",
  "MiniMax-M2.5",
  "MiniMax-M2.5-highspeed",
  "MiniMax-M2.1",
  "MiniMax-M2.1-highspeed",
  "MiniMax-M2",
];
