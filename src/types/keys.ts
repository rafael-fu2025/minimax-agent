/**
 * Wire types for the Multi-key API.
 */

export interface KeyInfo {
  id: string;
  name: string;
  prefix: string;
  hint: string | null;
  status: "active" | "disabled";
  isBootstrap: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  lastErrorAt: string | null;
  lastErrorMsg: string | null;
  requestsTotal: number;
  tokensInTotal: number;
  tokensOutTotal: number;
}

export interface KeysListResponse {
  keys: KeyInfo[];
  poolSize: number;
  activeCount: number;
}

export interface KeyUsageSummary {
  poolSize: number;
  activeCount: number;
  totals: {
    requestsTotal: number;
    tokensInTotal: number;
    tokensOutTotal: number;
  };
  keys: KeyInfo[];
}

export interface KeyTestResult {
  ok: boolean;
  modelCount?: number;
  error?: string;
}
