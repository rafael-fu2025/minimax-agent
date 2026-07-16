/**
 * Backfill embeddings for any persisted messages that aren't yet indexed.
 *
 * Idempotent: existing memory rows for the same `message_id` are updated in
 * place rather than duplicated. Safe to re-run after swapping embedding
 * models.
 *
 *   npm run db:reindex
 */

import "dotenv/config";
import { reindexAll } from "../memory.js";

async function main(): Promise<void> {
  console.log("[db:reindex] starting…");
  const result = await reindexAll(({ done, total }) => {
    const pct = total > 0 ? Math.floor((done / total) * 100) : 100;
    process.stdout.write(`\r[db:reindex] ${done}/${total} (${pct}%)    `);
  });
  process.stdout.write("\n");
  console.log(
    `[db:reindex] done. ${result.done}/${result.total} rows indexed.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[db:reindex] failed:", err);
  process.exit(1);
});
