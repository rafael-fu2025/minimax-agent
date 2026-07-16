/**
 * Per-key API key management. Mirrors the server's `/api/keys/*` endpoints.
 * All fetches return a `Result<T>` so callers can distinguish "server down"
 * from "empty list" — the old `T | null` shape collapsed both into null.
 */
import type { KeyInfo, KeysListResponse, KeyTestResult, KeyUsageSummary } from "./types/keys";
import type { Result } from "./api";

export async function fetchKeys(): Promise<Result<KeysListResponse>> {
  try {
    const res = await fetch("/api/keys");
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, data: (await res.json()) as KeysListResponse };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function fetchKeyUsage(): Promise<Result<KeyUsageSummary>> {
  try {
    const res = await fetch("/api/keys/usage");
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, data: (await res.json()) as KeyUsageSummary };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function addKey(input: {
  name: string;
  secret: string;
  hint?: string;
}): Promise<{ ok: true; key: KeyInfo } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch("/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  let json: { ok?: boolean; key?: KeyInfo; error?: string } = {};
  try {
    json = (await res.json()) as { ok?: boolean; key?: KeyInfo; error?: string };
  } catch {
    // fall through
  }
  if (!res.ok) {
    return { ok: false, error: json.error ?? `HTTP ${res.status}` };
  }
  if (!json.ok || !json.key) {
    return { ok: false, error: json.error ?? "unknown error" };
  }
  return { ok: true, key: json.key };
}

export async function updateKey(
  id: string,
  patch: { name?: string; status?: "active" | "disabled"; hint?: string | null },
): Promise<{ ok: true; key: KeyInfo } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(`/api/keys/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  let json: { ok?: boolean; key?: KeyInfo; error?: string } = {};
  try {
    json = (await res.json()) as { ok?: boolean; key?: KeyInfo; error?: string };
  } catch {
    // fall through
  }
  if (!res.ok || !json.ok || !json.key) {
    return { ok: false, error: json.error ?? `HTTP ${res.status}` };
  }
  return { ok: true, key: json.key };
}

export async function deleteKey(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  let res: Response;
  try {
    res = await fetch(`/api/keys/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  let json: { ok?: boolean; error?: string } = {};
  try {
    json = (await res.json()) as { ok?: boolean; error?: string };
  } catch {
    // fall through
  }
  if (!res.ok) {
    return { ok: false, error: json.error ?? `HTTP ${res.status}` };
  }
  return { ok: json.ok ?? false, error: json.error };
}

export async function testKey(id: string): Promise<KeyTestResult> {
  let res: Response;
  try {
    res = await fetch(`/api/keys/${encodeURIComponent(id)}/test`, {
      method: "POST",
    });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  let json: KeyTestResult = { ok: false };
  try {
    json = (await res.json()) as KeyTestResult;
  } catch {
    return { ok: false, error: `HTTP ${res.status}: non-JSON response` };
  }
  return json;
}

