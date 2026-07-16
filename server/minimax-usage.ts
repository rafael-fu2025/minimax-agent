/**
 * Wrap MiniMax's Token Plan "remains" endpoint:
 *   GET https://www.minimax.io/v1/token_plan/remains
 *   Headers: Authorization: Bearer <key>
 *
 * Returns per-model quota + remaining usage. We use the active key from
 * the KeyRotator (so per-key usage is reflected as you'd see it in the
 * dashboard if you only have that one key).
 */

import { getRotator } from "./keys/rotator.js";

const URL = process.env.MINIMAX_USAGE_URL ?? "https://www.minimax.io/v1/token_plan/remains";

export interface ModelRemain {
  modelName: string;
  /** 5h window start, epoch ms. */
  intervalStart: number;
  /** 5h window end, epoch ms. */
  intervalEnd: number;
  /** ms until the 5h window resets. */
  intervalRemainsMs: number;
  intervalTotal: number;
  intervalUsed: number;
  /** Percent remaining for the 5h window (0-100). */
  intervalRemainingPercent: number;
  /** Status code from MiniMax (1 = ok in our sample). */
  intervalStatus: number;

  /** Weekly window. */
  weeklyStart: number;
  weeklyEnd: number;
  weeklyRemainsMs: number;
  weeklyTotal: number;
  weeklyUsed: number;
  weeklyRemainingPercent: number;
  weeklyStatus: number;
}

export interface UsageResponse {
  /** ISO 8601 timestamp of when the server fetched this snapshot. */
  fetchedAt: string;
  /** True if the upstream call succeeded. */
  ok: boolean;
  /** Underlying model rows (one per model the user has access to). */
  modelRemains: ModelRemain[];
  /** Convenience aggregate (weighted average across models with the same window type). */
  /** 5h summary. */
  fiveHour: { totalQuota: number; totalUsed: number; remainingPercent: number; resetAt: string } | null;
  /** Weekly summary. */
  weekly: { totalQuota: number; totalUsed: number; remainingPercent: number; resetAt: string } | null;
  /** When the request failed. */
  error?: string;
}

function toNum(n: unknown): number {
  return typeof n === "number" ? n : Number(n) || 0;
}

interface RawRow {
  model_name?: string;
  start_time?: number;
  end_time?: number;
  remains_time?: number;
  current_interval_total_count?: number;
  current_interval_usage_count?: number;
  modelName?: string;
  current_weekly_total_count?: number;
  current_weekly_usage_count?: number;
  weekly_start_time?: number;
  weekly_end_time?: number;
  weekly_remains_time?: number;
  current_interval_status?: number;
  current_interval_remaining_percent?: number;
  current_weekly_status?: number;
  current_weekly_remaining_percent?: number;
}

function mapRow(raw: RawRow): ModelRemain {
  return {
    modelName: String(raw.model_name ?? raw.modelName ?? "unknown"),
    intervalStart: toNum(raw.start_time),
    intervalEnd: toNum(raw.end_time),
    intervalRemainsMs: toNum(raw.remains_time),
    intervalTotal: toNum(raw.current_interval_total_count),
    intervalUsed: toNum(raw.current_interval_usage_count),
    intervalRemainingPercent: toNum(raw.current_interval_remaining_percent),
    intervalStatus: toNum(raw.current_interval_status),
    weeklyStart: toNum(raw.weekly_start_time),
    weeklyEnd: toNum(raw.weekly_end_time),
    weeklyRemainsMs: toNum(raw.weekly_remains_time),
    weeklyTotal: toNum(raw.current_weekly_total_count),
    weeklyUsed: toNum(raw.current_weekly_usage_count),
    weeklyRemainingPercent: toNum(raw.current_weekly_remaining_percent),
    weeklyStatus: toNum(raw.current_weekly_status),
  };
}

/** Aggregate rows by window. The MiniMax endpoint returns the absolute
 *  counts (current_interval_total_count) as 0 for many keys and the
 *  remaining-percent as the source of truth. We therefore average the
 *  remaining-percent across rows (count-style simple mean, not weighted —
 *  weights are unavailable when totals are 0). */
function aggregate(rows: ModelRemain[], pick: "interval" | "weekly") {
  if (rows.length === 0) return null;
  const percents = rows.map((r) => (pick === "interval" ? r.intervalRemainingPercent : r.weeklyRemainingPercent));
  const remaining = percents.reduce((s, p) => s + p, 0) / percents.length;
  const resetMs = Math.min(...rows.map((r) => (pick === "interval" ? r.intervalRemainsMs : r.weeklyRemainsMs)));
  return {
    totalQuota: 0,
    totalUsed: 0,
    remainingPercent: Math.round(remaining),
    resetAt: new Date(Date.now() + resetMs).toISOString(),
  };
}

export async function fetchUsage(): Promise<UsageResponse> {
  const fetchedAt = new Date().toISOString();
  const rot = await getRotator();
  try {
    const res = await rot.call(async (secret) =>
      fetch(URL, {
        method: "GET",
        headers: { Authorization: `Bearer ${secret}` },
      })
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return {
        fetchedAt,
        ok: false,
        modelRemains: [],
        fiveHour: null,
        weekly: null,
        error: `HTTP ${res.status}: ${txt.slice(0, 200)}`,
      };
    }
    const json = (await res.json()) as { model_remains?: RawRow[] };
    const rows = (json.model_remains ?? []).map(mapRow);
    return {
      fetchedAt,
      ok: true,
      modelRemains: rows,
      fiveHour: aggregate(rows, "interval"),
      weekly: aggregate(rows, "weekly"),
    };
  } catch (err) {
    return {
      fetchedAt,
      ok: false,
      modelRemains: [],
      fiveHour: null,
      weekly: null,
      error: (err as Error).message,
    };
  }
}

