-- Partial index on `conversations.last_error` so the error UI can list
-- errored conversations without scanning the table. The index only covers
-- rows where `last_error IS NOT NULL`, which is the only set the UI cares
-- about (success-state rows are irrelevant).
CREATE INDEX IF NOT EXISTS "conversations_last_error_partial_idx"
  ON "conversations" ("last_error")
  WHERE "last_error" IS NOT NULL;
