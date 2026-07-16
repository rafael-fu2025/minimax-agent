/**
 * Standalone migration runner. Invoked by `npm run db:migrate`.
 *
 * Uses Drizzle's migrator against the configured `DATABASE_URL`. Fails
 * loudly if the URL is missing — unlike the server's lazy DB helpers,
 * migrations should never silently no-op.
 */

import "dotenv/config";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, isDbConfigured } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  if (!isDbConfigured()) {
    console.error(
      "[db:migrate] DATABASE_URL is not set. Add one to .env (see .env.example) and try again.",
    );
    process.exit(1);
  }
  const migrationsFolder = resolve(__dirname, "migrations");
  console.log(`[db:migrate] applying migrations from ${migrationsFolder}`);
  await migrate(getDb(), { migrationsFolder });
  console.log("[db:migrate] done.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[db:migrate] failed:", err);
  process.exit(1);
});
