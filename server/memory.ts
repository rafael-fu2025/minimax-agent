/**
 * Memory repository: vector-index every persisted message and let the agent
 * recall relevant past content before a turn.
 *
 * Indexing is fire-and-forget from the caller; failures must never interrupt
 * the SSE stream. Use `safeMemory` in `server/index.ts` to wrap calls.
 *
 * Retrieval uses pgvector's cosine-distance operator (`<=>`). The closer the
 * distance, the more similar. We expose `score = 1 - distance` so callers
 * can read similarity directly.
 */

import { sql } from "drizzle-orm";
import { getDb } from "./db/index.js";
import { memories } from "./db/schema.js";
import { getEmbeddings } from "./embeddings.js";

export interface MemoryHit {
  id: string; // bigserial, serialized as string for JSON safety
  conversationId: string;
  messageId: string;
  role: "user" | "assistant";
  content: string;
  score: number; // 1 - cosine distance; 1 = identical, 0 = orthogonal
  createdAt: Date;
}

export interface IndexMessageInput {
  conversationId: string;
  messageId: bigint;
  role: "user" | "assistant";
  content: string;
}

/* -------------------------------------------------------------------------- */
/* Index                                                                       */
/* -------------------------------------------------------------------------- */

export async function indexMessage(input: IndexMessageInput): Promise<void> {
  const text = (input.content ?? "").trim();
  if (!text) return; // Skip empty / whitespace-only content.

  const db = getDb();
  const [vec] = await getEmbeddings().embed([text], "db");
  // Atomic upsert by messageId. Replaces the previous select-then-insert
  // pattern, which had a race when two concurrent indexes landed on the
  // same message.
  await db
    .insert(memories)
    .values({
      conversationId: input.conversationId,
      messageId: input.messageId,
      role: input.role,
      content: text,
      embedding: vec as never,
    })
    .onConflictDoUpdate({
      target: memories.messageId,
      set: {
        role: input.role,
        content: text,
        embedding: vec as never,
      },
    });
}

/* -------------------------------------------------------------------------- */
/* Recall                                                                      */
/* -------------------------------------------------------------------------- */

export async function retrieveTopK(
  query: string,
  k = 5,
  minScore = 0,
): Promise<MemoryHit[]> {
  const text = query.trim();
  if (!text) return [];
  const db = getDb();

  const [vec] = await getEmbeddings().embed([text], "query");
  const embeddingLiteral = formatVectorLiteral(vec);

  // pgvector's <=> returns cosine DISTANCE (1 - similarity). We push the
  // score threshold into the SQL `WHERE` so the HNSW index prunes early
  // instead of returning k candidates and filtering them in app code.
  const rows = await db.execute<{
    id: string;
    conversation_id: string;
    message_id: string;
    role: string;
    content: string;
    score: number;
    created_at: Date;
  }>(sql`
    SELECT
      id::text                                    AS id,
      conversation_id                             AS conversation_id,
      message_id::text                            AS message_id,
      role                                        AS role,
      content                                     AS content,
      1 - (embedding <=> ${embeddingLiteral}::vector) AS score,
      created_at                                  AS created_at
    FROM memories
    WHERE 1 - (embedding <=> ${embeddingLiteral}::vector) >= ${minScore}
    ORDER BY embedding <=> ${embeddingLiteral}::vector
    LIMIT ${k}
  `);

  const hits: MemoryHit[] = (rows.rows ?? []).map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    messageId: r.message_id,
    role: r.role as "user" | "assistant",
    content: r.content,
    // Clamp NaN from a degenerate zero vector.
    score: Number.isFinite(r.score) ? r.score : 0,
    createdAt: new Date(r.created_at),
  }));
  return hits;
}

/* -------------------------------------------------------------------------- */
/* Admin / debugging                                                           */
/* -------------------------------------------------------------------------- */

export async function countMemories(): Promise<number> {
  const db = getDb();
  const rows = await db.execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM memories`,
  );
  return Number(rows.rows?.[0]?.count ?? 0);
}

export interface ReindexProgress {
  total: number;
  done: number;
}

export async function reindexAll(
  onProgress?: (p: ReindexProgress) => void,
): Promise<ReindexProgress> {
  const db = getDb();
  const totalRows = await db.execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM messages WHERE role IN ('user','assistant') AND content IS NOT NULL AND length(content) > 0`,
  );
  const total = Number(totalRows.rows?.[0]?.count ?? 0);

  // Stream the message table in keyset-paginated chunks instead of
  // materialising every row into Node memory at once. Previous behaviour
  // worked fine for a few hundred rows but blew up at ~100k.
  const chunkSize = 32;
  let lastId = "0";
  let done = 0;
  for (;;) {
    const batch = await db.execute<{
      id: string;
      conversation_id: string;
      role: string;
      content: string;
    }>(sql`
      SELECT id::text AS id, conversation_id, role, content
      FROM messages
      WHERE role IN ('user','assistant')
        AND content IS NOT NULL
        AND length(content) > 0
        AND id::text > ${lastId}
      ORDER BY id
      LIMIT ${chunkSize}
    `);
    const slice = batch.rows ?? [];
    if (slice.length === 0) break;
    lastId = slice[slice.length - 1].id;
    const texts = slice.map((r) => r.content);
    let vecs: number[][];
    try {
      vecs = await getEmbeddings().embed(texts, "db");
    } catch (err) {
      console.warn(
        `[memory] reindex embed chunk failed (skipping ${slice.length} rows):`,
        (err as Error).message,
      );
      done += slice.length;
      onProgress?.({ done, total });
      continue;
    }
    for (let j = 0; j < slice.length; j++) {
      const row = slice[j];
      const vec = vecs[j];
      try {
        // Upsert by messageId so re-runs are safe. ON CONFLICT avoids
        // a separate select-then-insert round-trip per row.
        await db
          .insert(memories)
          .values({
            conversationId: row.conversation_id,
            messageId: BigInt(row.id),
            role: row.role,
            content: row.content,
            embedding: vec as never,
          })
          .onConflictDoUpdate({
            target: memories.messageId,
            set: {
              role: row.role,
              content: row.content,
              embedding: vec as never,
              conversationId: row.conversation_id,
            },
          });
      } catch (err) {
        console.warn(
          `[memory] reindex row ${row.id} failed:`,
          (err as Error).message,
        );
      }
      done += 1;
    }
    onProgress?.({ done, total });
  }
  return { done, total };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Format a number[] as a Postgres vector literal: "[v1,v2,...]". pgvector
 * accepts the same parseable form Drizzle renders in queries. We pass this
 * as a bound parameter via the `::vector` cast in the SQL.
 */
function formatVectorLiteral(vec: number[]): string {
  // Trim/validate numeric shape; pgvector doesn't accept null/NaN in literals.
  let body = "";
  for (let i = 0; i < vec.length; i++) {
    const n = vec[i];
    if (!Number.isFinite(n)) {
      throw new Error(`embedding[${i}] is not finite: ${n}`);
    }
    body += (i === 0 ? "" : ",") + Number(n.toFixed(8));
  }
  return `[${body}]`;
}

/**
 * Build a recall block string the agent loop can prepend to the system prompt.
 * Returns "" if there are no hits (or all below the similarity threshold).
 */
export function buildRecallBlock(hits: MemoryHit[], maxCharsPerHit = 200): string {
  if (hits.length === 0) return "";
  const lines = hits.map((h) => {
    const short = h.content.length > maxCharsPerHit
      ? `${h.content.slice(0, maxCharsPerHit - 1)}…`
      : h.content;
    const convShort = h.conversationId.slice(0, 8);
    return `- [conv ${convShort} / ${h.role}, sim=${h.score.toFixed(2)}] ${short}`;
  });
  return [
    "Relevant prior context (across all conversations):",
    ...lines,
  ].join("\n");
}
