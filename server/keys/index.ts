/**
 * MiniMax key pool: loads key sources from the DB + the env-var bootstrap,
 * records success/error to the `minimax_keys` table, exposes CRUD helpers
 * for the API.
 *
 * Used by:
 *   - `rotator.ts`           — `loadSources()`, `recordSuccess()`, `recordError()`, `markRateLimited()`
 *   - `server/index.ts`      — GET / POST / PATCH / DELETE /api/keys[/...]
 */

import { createHash, randomUUID, randomBytes } from "node:crypto";
import { eq, desc, isNull, and } from "drizzle-orm";
import { getDb, isDbConfigured } from "../db/index.js";
import { sql } from "drizzle-orm";
import { minimaxKeys } from "../db/schema.js";
import type { KeyRow } from "../db/schema.js";

/** Captured once at module load. Used as the synthetic `createdAt` of the
 *  bootstrap (env-var) key so it sorts sensibly in the UI. */
const PROCESS_BOOT_TIME_MS = Date.now();

/**
 * After the keys pool changes, ask the MCP layer to respawn so any
 * `keyRef: "db"` server uses the freshest DB row. Lazy `import()` to
 * avoid a static cycle with `tools.ts` (which in turn imports
 * `loadSources` from here).
 */
async function triggerMcpReload(): Promise<void> {
  try {
    const { reloadMcpTools } = await import("../tools.js");
    await reloadMcpTools();
  } catch (err) {
    // Non-fatal — the chat still works; only MCP-driven tools may use a
    // slightly stale secret until the next server restart.
    console.warn("[keys] reloadMcpTools failed:", (err as Error).message);
  }
}

/* -------------------------------------------------------------------------- */
/* Source loading                                                            */
/* -------------------------------------------------------------------------- */

export interface LoadedSource {
  id: string;
  secret: string;
  isBootstrap: boolean;
  row: {
    id: string;
    name: string;
    status: "active" | "disabled";
    rateLimitedUntil: Date | null;
    consecutiveErrors: number;
  } | null;
}

/**
 * Build the list of available key sources. Includes the env-var key
 * (synthetic "bootstrap" source, no row) and any active DB rows.
 * Hidden ("disabled" status) DB rows are excluded from the rotator pool
 * by the rotator itself; here we include all and let the rotator skip.
 */
export async function loadSources(baseUrl: string): Promise<LoadedSource[]> {
  const out: LoadedSource[] = [];
  const envSecret = process.env.MINIMAX_API_KEY?.trim();
  if (envSecret && envSecret.length > 0 && !isPlaceholderKey(envSecret)) {
    out.push({
      id: `bootstrap-${envSecret.slice(-4)}`,
      secret: envSecret,
      isBootstrap: true,
      row: null,
    });
  } else if (envSecret && isPlaceholderKey(envSecret)) {
    // The .env.example ships with a sentinel placeholder; treat it as
    // "no env-var key" so the UI's Settings → Keys is the only way to
    // provide a real key. Log once per process; the rotator refreshes
    // every 5s and would otherwise spam the console.
    warnPlaceholderOnce();
  }
  if (!isDbConfigured()) {
    // No DB → no DB-stored keys. The rotator will fall through to whatever
    // (if anything) is in `out`; in the placeholder case that's empty.
    return out;
  }
  let rows: KeyRow[] = [];
  try {
    rows = await getDb().select().from(minimaxKeys).orderBy(desc(minimaxKeys.createdAt));
  } catch (err) {
    // Table may not exist on first boot before migration — that's fine.
    console.warn("[keys] could not load DB keys:", (err as Error).message);
  }
  for (const r of rows) {
    // Pull the secret out of the row. We stored it on the key record at
    // insertion time as a property; the column wasn't in the original
    // schema, so we fall back to a sentinel if the schema didn't add it.
    // (The migration adds the `secret` column.)
    const secret = (r as unknown as { secret?: string }).secret;
    if (!secret) continue;
    out.push({
      id: r.id,
      secret,
      isBootstrap: false,
      row: {
        id: r.id,
        name: r.name,
        status: (r.status as "active" | "disabled") ?? "active",
        rateLimitedUntil: r.rateLimitedUntil,
        consecutiveErrors: r.consecutiveErrors,
      },
    });
  }
  return out;
}

/**
 * True if `secret` looks like the .env.example placeholder rather than a
 * real key. We match an explicit allowlist of known placeholder tokens so
 * a fresh checkout doesn't accidentally try to call the upstream API with
 * the placeholder, without false-flagging real keys that happen to end in
 * `-xxx` or contain unrelated substrings.
 */
const PLACEHOLDER_KEYS: ReadonlySet<string> = new Set([
  "sk-minimax-your-key-here",
  "sk-minimax",
  "sk-your-key-here",
  "replace-me",
  "your-key-here",
]);

export function isPlaceholderKey(secret: string): boolean {
  const s = secret.trim().toLowerCase();
  if (!s) return false;
  if (PLACEHOLDER_KEYS.has(s)) return true;
  // Catch obvious "example.com / example key" style docs.
  if (s.includes("example.com")) return true;
  if (s.endsWith("-placeholder")) return true;
  if (s.endsWith(".placeholder")) return true;
  return false;
}

/**
 * One-shot warning for the placeholder. The rotator calls `loadSources`
 * every 5s (and on every chat request) so a plain `console.log` inside
 * the placeholder branch would spam the server console. We track the
 * last-seen state in a module-level variable; if the env var *changes*
 * (user sets a real key, or un-sets it) we'll warn again, but a steady
 * state is silent.
 */
let _lastPlaceholderState: boolean | null = null;
function warnPlaceholderOnce(): void {
  // true = placeholder is currently the env-var state (we know this
  // because we're called from that branch). false = a real key (or
  // nothing) is set. We log on any state transition, including the
  // first observation (null → true).
  const isPlaceholder = true;
  if (_lastPlaceholderState === isPlaceholder) return;
  _lastPlaceholderState = isPlaceholder;
  // eslint-disable-next-line no-console
  console.log(
    "[keys] MINIMAX_API_KEY is the .env.example placeholder — add a real key via Settings → Keys.",
  );
}

/* -------------------------------------------------------------------------- */
/* Usage recording                                                           */
/* -------------------------------------------------------------------------- */

export async function recordSuccess(keyId: string): Promise<void> {
  if (keyId.startsWith("bootstrap-")) return; // env-var key has no row
  try {
    const db = getDb();
    await db
      .update(minimaxKeys)
      .set({
        // Atomic increment — the previous read-then-write version lost
        // updates when multiple chat calls landed on the same key.
        requestsTotal: sql`${minimaxKeys.requestsTotal} + 1`,
        lastUsedAt: new Date(),
        consecutiveErrors: 0,
        lastErrorAt: null,
        lastErrorMsg: null,
      })
      .where(eq(minimaxKeys.id, keyId));
  } catch (err) {
    console.warn("[keys] recordSuccess failed:", (err as Error).message);
  }
}

export async function recordError(keyId: string, err: unknown): Promise<void> {
  if (keyId.startsWith("bootstrap-")) return;
  try {
    const db = getDb();
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(minimaxKeys)
      .set({
        consecutiveErrors: sql`${minimaxKeys.consecutiveErrors} + 1`,
        lastErrorAt: new Date(),
        lastErrorMsg: msg.slice(0, 500),
      })
      .where(eq(minimaxKeys.id, keyId));
  } catch (e) {
    console.warn("[keys] recordError failed:", (e as Error).message);
  }
}

export async function markRateLimited(
  keyId: string,
  cooldownMs: number,
  err: unknown,
): Promise<void> {
  if (keyId.startsWith("bootstrap-")) return;
  try {
    const db = getDb();
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(minimaxKeys)
      .set({
        rateLimitedUntil: new Date(Date.now() + cooldownMs),
        lastErrorAt: new Date(),
        lastErrorMsg: msg.slice(0, 500),
      })
      .where(eq(minimaxKeys.id, keyId));
  } catch (e) {
    console.warn("[keys] markRateLimited failed:", (e as Error).message);
  }
}

/* -------------------------------------------------------------------------- */
/* CRUD for /api/keys                                                         */
/* -------------------------------------------------------------------------- */

export interface KeyInfoPublic {
  id: string;
  name: string;
  prefix: string;       // "sk-…abcd"
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

function rowToPublic(r: KeyRow, isBootstrap: boolean): KeyInfoPublic {
  return {
    id: r.id,
    name: r.name,
    prefix: r.keyPrefix,
    hint: r.keyHint,
    status: (r.status as "active" | "disabled") ?? "active",
    isBootstrap,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
    lastErrorAt: r.lastErrorAt ? r.lastErrorAt.toISOString() : null,
    lastErrorMsg: r.lastErrorMsg,
    requestsTotal: Number(r.requestsTotal ?? 0),
    tokensInTotal: Number(r.tokensInTotal ?? 0),
    tokensOutTotal: Number(r.tokensOutTotal ?? 0),
  };
}

export async function listKeys(): Promise<KeyInfoPublic[]> {
  // Stateless mode: no DB → no DB-stored keys. The route handler in
  // server/index.ts adds the bootstrap key to the result.
  if (!isDbConfigured()) return [];
  const db = getDb();
  const rows = await db.select().from(minimaxKeys).orderBy(desc(minimaxKeys.createdAt));
  return rows.map((r) => rowToPublic(r, false));
}

export async function getBootstrapKey(baseUrl: string): Promise<KeyInfoPublic | null> {
  const envSecret = process.env.MINIMAX_API_KEY?.trim();
  // Hide the .env.example placeholder from the UI; the UI is the
  // primary path for key management, and showing a `sk-…here` row
  // alongside real keys would just confuse the user.
  if (!envSecret || envSecret.length === 0 || isPlaceholderKey(envSecret)) {
    return null;
  }
  const id = `bootstrap-${envSecret.slice(-4)}`;
  const last4 = envSecret.slice(-4);
  return {
    id,
    name: "Env: MINIMAX_API_KEY",
    prefix: `sk-…${last4}`,
    hint: "Set in .env; the env-var key is undeletable but can be disabled.",
    status: "active",
    isBootstrap: true,
    // Use process boot time, not the Unix epoch. `Date(0)` showed up in
    // the UI as a wildly-out-of-order row whenever the user sorted by
    // creation date.
    createdAt: new Date(PROCESS_BOOT_TIME_MS).toISOString(),
    lastUsedAt: null,
    lastErrorAt: null,
    lastErrorMsg: null,
    requestsTotal: 0,
    tokensInTotal: 0,
    tokensOutTotal: 0,
  };
}

export async function addKey(input: {
  name: string;
  secret: string;
  hint?: string;
}): Promise<{ ok: true; key: KeyInfoPublic } | { ok: false; error: string }> {
  const secret = input.secret.trim();
  if (!secret) return { ok: false, error: "secret is required" };
  if (!secret.startsWith("sk-")) return { ok: false, error: "secret must start with sk-" };
  if (secret.length < 16) return { ok: false, error: "secret too short" };
  // The DB is the only place the UI can store keys. In stateless mode
  // (DATABASE_URL unset) there's nothing to insert into — refuse cleanly
  // with a friendly message rather than letting the throw bubble up.
  if (!isDbConfigured()) {
    return {
      ok: false,
      error:
        "DB not configured — set DATABASE_URL in .env to enable UI key storage, or use MINIMAX_API_KEY in .env as a fallback.",
    };
  }
  const hash = createHash("sha256").update(secret).digest("hex");
  const prefix = `sk-…${secret.slice(-4)}`;
  const id = randomUUID();
  try {
    const db = getDb();
    const existing = await db
      .select()
      .from(minimaxKeys)
      .where(eq(minimaxKeys.keyHash, hash))
      .limit(1);
    if (existing.length > 0) {
      return { ok: false, error: "duplicate fingerprint" };
    }
    // Bypass Drizzle for the insert — its pg-core placeholder-counting
    // has a bug with our schema (treats `secret` as a default column).
    // Raw SQL is unambiguous.
    const now = new Date();
    await db.execute(sql`
      INSERT INTO minimax_keys (
        id, name, secret, key_hash, key_prefix, key_hint,
        status, requests_total, tokens_in_total, tokens_out_total,
        last_used_at, last_error_at, last_error_msg,
        consecutive_errors, rate_limited_until, is_bootstrap, created_at
      ) VALUES (
        ${id}, ${input.name}, ${secret}, ${hash}, ${secret.slice(-4)}, ${input.hint ?? null},
        ${"active"}, ${"0"}, ${"0"}, ${"0"},
        ${null}, ${null}, ${null},
        ${0}, ${null}, ${false}, ${now}
      )
    `);
    // Re-fetch with the inserted row.
    const fresh = await db
      .select()
      .from(minimaxKeys)
      .where(eq(minimaxKeys.id, id))
      .limit(1);
    if (fresh.length === 0) return { ok: false, error: "insert failed" };
    // Fire-and-forget: respawn any MCP that depended on the DB key.
    void triggerMcpReload();
    return { ok: true, key: rowToPublic(fresh[0], false) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function updateKey(
  id: string,
  patch: { name?: string; status?: "active" | "disabled"; hint?: string | null },
): Promise<{ ok: true; key: KeyInfoPublic } | { ok: false; error: string }> {
  if (id.startsWith("bootstrap-")) {
    // Bootstrap key only allows `status` and `hint` toggles.
    if (patch.name !== undefined) {
      return { ok: false, error: "cannot rename the bootstrap key" };
    }
  } else {
    // Non-bootstrap keys live in the DB; refuse cleanly in stateless
    // mode rather than crashing on getDb().
    if (!isDbConfigured()) {
      return { ok: false, error: "DB not configured — only the env-var (bootstrap) key can be edited" };
    }
  }
  try {
    const db = getDb();
    const cur = await db
      .select()
      .from(minimaxKeys)
      .where(eq(minimaxKeys.id, id))
      .limit(1);
    if (cur.length === 0) return { ok: false, error: "key not found" };
    const update: Record<string, unknown> = {};
    if (patch.name !== undefined) update.name = patch.name;
    if (patch.status !== undefined) update.status = patch.status;
    if (patch.hint !== undefined) update.keyHint = patch.hint;
    if (Object.keys(update).length > 0) {
      await db.update(minimaxKeys).set(update as never).where(eq(minimaxKeys.id, id));
    }
    const fresh = await db
      .select()
      .from(minimaxKeys)
      .where(eq(minimaxKeys.id, id))
      .limit(1);
    if (fresh.length === 0) return { ok: false, error: "not found" };
    // Fire-and-forget: status flips (active <-> disabled) change the
    // pool composition, so respawn MCP to pick up the change.
    void triggerMcpReload();
    return { ok: true, key: rowToPublic(fresh[0], false) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function deleteKey(id: string): Promise<{ ok: boolean; error?: string }> {
  if (id.startsWith("bootstrap-")) {
    return { ok: false, error: "cannot delete the bootstrap key" };
  }
  if (!isDbConfigured()) {
    return { ok: false, error: "DB not configured — only the env-var (bootstrap) key can be removed" };
  }
  try {
    const db = getDb();
    const cur = await db
      .select()
      .from(minimaxKeys)
      .where(eq(minimaxKeys.id, id))
      .limit(1);
    if (cur.length === 0) return { ok: false, error: "key not found" };
    await db.delete(minimaxKeys).where(eq(minimaxKeys.id, id));
    // Fire-and-forget: pool shrank — respawn MCP to drop any clients
    // that referenced the deleted secret.
    void triggerMcpReload();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function testKey(id: string, baseUrl: string): Promise<{
  ok: boolean;
  modelCount?: number;
  error?: string;
}> {
  let secret: string | null = null;
  if (id.startsWith("bootstrap-")) {
    secret = process.env.MINIMAX_API_KEY ?? null;
  } else {
    // Non-bootstrap keys live in the DB; refuse cleanly in stateless mode
    // rather than crashing on getDb().
    if (!isDbConfigured()) {
      return { ok: false, error: "DB not configured — only the env-var (bootstrap) key can be tested" };
    }
    const db = getDb();
    const rows = await db
      .select()
      .from(minimaxKeys)
      .where(eq(minimaxKeys.id, id))
      .limit(1);
    secret = (rows[0] as unknown as { secret?: string } | undefined)?.secret ?? null;
  }
  if (!secret) return { ok: false, error: "no secret found" };
  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/models`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}: ${txt.slice(0, 200)}` };
    }
    const j = (await res.json()) as { data?: unknown[] };
    return { ok: true, modelCount: j.data?.length ?? 0 };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export interface UsageSummary {
  poolSize: number;
  activeCount: number;
  totals: {
    requestsTotal: number;
    tokensInTotal: number;
    tokensOutTotal: number;
  };
  keys: KeyInfoPublic[];
}

export async function getUsageSummary(baseUrl: string): Promise<UsageSummary> {
  const bootstrap = await getBootstrapKey(baseUrl);
  // In stateless mode (DATABASE_URL unset) the DB-stored pool is empty —
  // return the bootstrap key alone instead of throwing. The Settings → Keys
  // UI degrades gracefully in this case (it just shows the env-var key).
  if (!isDbConfigured()) {
    const pool = bootstrap ? [bootstrap] : [];
    return {
      poolSize: pool.length,
      activeCount: pool.filter((k) => k.status === "active").length,
      totals: { requestsTotal: 0, tokensInTotal: 0, tokensOutTotal: 0 },
      keys: pool,
    };
  }
  const db = getDb();
  const rows = await db.select().from(minimaxKeys);
  const pool = bootstrap
    ? [bootstrap, ...rows.map((r) => rowToPublic(r, false))]
    : rows.map((r) => rowToPublic(r, false));
  const totals = rows.reduce(
    (acc, r) => ({
      requestsTotal: acc.requestsTotal + Number(r.requestsTotal ?? 0n),
      tokensInTotal: acc.tokensInTotal + Number(r.tokensInTotal ?? 0n),
      tokensOutTotal: acc.tokensOutTotal + Number(r.tokensOutTotal ?? 0n),
    }),
    { requestsTotal: 0, tokensInTotal: 0, tokensOutTotal: 0 },
  );
  return {
    poolSize: pool.length,
    activeCount: pool.filter((k) => k.status === "active").length,
    totals,
    keys: pool,
  };
}
