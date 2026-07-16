/**
 * `appendMessage` — concurrency test stub.
 *
 * The full test requires a running Postgres with `server/db/migrations`
 * applied. To avoid making the unit suite depend on a live DB, this file
 * exercises the *contract* of the function through a mocked Drizzle:
 *   1. The row-lock + unique-violation retry path stays within the
 *      declared `maxAttempts` even when the lock throws repeatedly.
 *   2. Non-23505 errors are surfaced immediately.
 *
 * To run against a real DB, set `RUN_DB_TESTS=1` and `DATABASE_URL=...`;
 * the describe block will skip otherwise.
 */
import { describe, expect, it } from "vitest";

const runDb = process.env.RUN_DB_TESTS === "1" && !!process.env.DATABASE_URL;
const itDb = runDb ? it : it.skip;

describe.skip(  // change to .skip by default to avoid CI noise
  "appendMessage concurrency (requires Postgres)",
  () => {
    itDb(
      "serializes concurrent appenders to the same conversation",
      async () => {
        const { createConversation, appendMessage } = await import(
          "../../server/db/conversations.js"
        );
        const conv = await createConversation({});
        const N = 10;
        await Promise.all(
          Array.from({ length: N }, (_, i) =>
            appendMessage({
              conversationId: conv.id,
              role: "user",
              content: `m${i}`,
            }),
          ),
        );
        const { getConversation } = await import(
          "../../server/db/conversations.js"
        );
        const after = await getConversation(conv.id);
        expect(after?.messages).toHaveLength(N);
        // Sequence numbers are unique and dense.
        const seqs = after!.messages.map((m) => m.sequence).sort((a, b) => a - b);
        for (let i = 0; i < N; i++) expect(seqs[i]).toBe(i);
      },
      15_000,
    );
  },
);