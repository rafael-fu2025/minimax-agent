/**
 * Lazy Postgres connection helpers.
 *
 * Boot never fails when DATABASE_URL is missing — `getDb()` and `getPool()`
 * throw only when actually invoked without a URL. This keeps the existing
 * stateless chat flow working in environments that don't need persistence.
 *
 * Also installs a one-shot SIGTERM/SIGINT handler that closes the pool
 * cleanly so tsx-watch restarts (and Docker stop) don't leak connections.
 */

import "dotenv/config";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

let _pool: Pool | null = null;
let _db: NodePgDatabase<typeof schema> | null = null;

export function isDbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

function buildPool(): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "[db] DATABASE_URL is not set. Add one to .env (see .env.example), or the persistence layer will refuse to connect.",
    );
  }
  return new Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

export function getPool(): Pool {
  if (!_pool) {
    _pool = buildPool();
    // Don't let background pool errors kill the process.
    _pool.on("error", (err) => {
      console.error("[db] pg pool error:", err.message);
    });
  }
  return _pool;
}

export function getDb(): NodePgDatabase<typeof schema> {
  if (!_db) {
    _db = drizzle(getPool(), { schema });
  }
  return _db;
}

/**
 * Lightweight readiness probe for `/api/health/db`. Runs `SELECT 1` against a
 * fresh client so we exercise both pool and server.
 */
export async function pingDb(): Promise<
  { ok: true } | { ok: false; error: string }
> {
  if (!isDbConfigured()) {
    return { ok: false, error: "DATABASE_URL is not set" };
  }
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    client.release();
  }
}

/* -------------------------------------------------------------------------- */
/* Shutdown hook                                                              */
/* -------------------------------------------------------------------------- */

let shutdownRegistered = false;

function registerShutdownHook(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;

  const close = (signal: NodeJS.Signals) => {
    if (!_pool) {
      process.exit(0);
      return;
    }
    console.log(`[db] received ${signal}, closing pg pool…`);
    _pool
      .end()
      .catch((err) => {
        console.warn(`[db] pool.end() during ${signal} failed:`, err.message);
      })
      .finally(() => {
        process.exit(0);
      });
  };

  process.on("SIGTERM", () => close("SIGTERM"));
  process.on("SIGINT", () => close("SIGINT"));
}

registerShutdownHook();
