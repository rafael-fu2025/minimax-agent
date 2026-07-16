/**
 * Wire type returned by `GET /api/usage`. Mirrors the server's
 * `UsageResponse` shape.
 */

export interface ModelRemain {
  modelName: string;
  intervalStart: number;
  intervalEnd: number;
  intervalRemainsMs: number;
  intervalTotal: number;
  intervalUsed: number;
  intervalRemainingPercent: number;
  intervalStatus: number;
  weeklyStart: number;
  weeklyEnd: number;
  weeklyRemainsMs: number;
  weeklyTotal: number;
  weeklyUsed: number;
  weeklyRemainingPercent: number;
  weeklyStatus: number;
}

export interface UsageQuotaSummary {
  totalQuota: number;
  totalUsed: number;
  remainingPercent: number;
  resetAt: string;
}

export interface UsageResponse {
  fetchedAt: string;
  ok: boolean;
  modelRemains: ModelRemain[];
  fiveHour: UsageQuotaSummary | null;
  weekly: UsageQuotaSummary | null;
  error?: string;
}
