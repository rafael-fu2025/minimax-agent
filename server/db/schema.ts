/**
 * Drizzle schema for the persistence layer.
 *
 * Three tables:
 *   - conversations: top-level metadata. `id` is a client- and server-mintable
 *     UUID v4 string so both sides can agree without a round-trip.
 *   - messages: append-only log inside a conversation. `sequence` is monotonic
 *     per conversation; uniqueness is enforced by the DB and exploited by
 *     the row-lock + retry in `appendMessage`.
 *   - memories: vector index of user/assistant message content. Embeddings
 *     are written by `server/embeddings.ts` and looked up via pgvector's
 *     cosine-distance operator (`<=>`). HNSW index for sub-millisecond
 *     similarity search.
 *
 * Tool calls live inside their parent assistant message's `tool_calls` JSONB
 * column (OpenAI-compatible shape). No separate tool-invocations table.
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  vector,
} from "drizzle-orm/pg-core";

/**
 * UUID v4 regex. Applied as a CHECK constraint on `conversations.id` so
 * out-of-band SQL can't sneak garbage into the table.
 */
export const UUID_REGEX =
  "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

/**
 * Embedding vector dimension. The default 1024 matches the typical
 * MiniMax-class embedder output; override via `EMBEDDING_DIM` env in `.env`.
 * Changing this requires a reindex (run `npm run db:reindex`).
 */
export const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM ?? 1024);

export const conversations = pgTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull().default("New conversation"),
    model: text("model"),
    systemPrompt: text("system_prompt"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    messageCount: integer("message_count").notNull().default(0),
  },
  (table) => ({
    idCheck: check(
      "conversations_id_uuid_check",
      sql.raw(`"conversations"."id" ~ '${UUID_REGEX}'`),
    ),
  }),
);

export const messages = pgTable(
  "messages",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content"),
    thinking: text("thinking"),
    toolCalls: jsonb("tool_calls"),
    toolCallId: text("tool_call_id"),
    toolName: text("tool_name"),
    usage: jsonb("usage"),
    /**
     * Multimodal content parts sent on this user turn (image_url, video_url,
     * text). `content` keeps the joined plain-text version so existing
     * consumers (auto-title, memory indexing, search) don't break. The full
     * parts array lives here so reopening a chat shows the original uploads.
     */
    attachments: jsonb("attachments"),
    sequence: integer("sequence").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    uniqueSequence: unique("messages_unique_sequence").on(
      table.conversationId,
      table.sequence,
    ),
    roleCheck: check(
      "messages_role_check",
      sql.raw(`"messages"."role" IN ('system','user','assistant','tool')`),
    ),
    toolCallsCheck: check(
      "messages_tool_calls_check",
      sql.raw(
        `"messages"."tool_calls" IS NULL OR jsonb_typeof("messages"."tool_calls") = 'array'`,
      ),
    ),
    attachmentsCheck: check(
      "messages_attachments_check",
      sql.raw(
        `"messages"."attachments" IS NULL OR jsonb_typeof("messages"."attachments") = 'array'`,
      ),
    ),
  }),
);

export type ConversationRow = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type MessageRow = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

/* -------------------------------------------------------------------------- */
/* Memories (vector index)                                                    */
/* -------------------------------------------------------------------------- */

export const memories = pgTable(
  "memories",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /**
     * Soft reference to the source message. We don't FK this because:
     *   - messages are append-only and we already cascade via conversation_id;
     *   - we want to be free to re-embed the same message later (model swap)
     *     without the unique-violation semantics that an FK would invite.
     */
    messageId: bigint("message_id", { mode: "bigint" }).notNull(),
    role: text("role").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIM }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    roleCheck: check(
      "memories_role_check",
      sql.raw(`"memories"."role" IN ('user','assistant')`),
    ),
    // HNSW index on cosine distance; best recall/speed for < ~1M rows.
    embeddingIdx: index("memories_embedding_hnsw").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
    conversationIdx: index("memories_conversation_idx").on(
      table.conversationId,
    ),
    messageIdx: index("memories_message_idx").on(table.messageId),
  }),
);

export type MemoryRow = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;

/* -------------------------------------------------------------------------- */
/* MiniMax API keys (multi-key rotation pool)                                */
/* -------------------------------------------------------------------------- */

/**
 * One row per API key the user wants to use for MiniMax chat + embeddings.
 * Secrets are stored in plaintext — fine for personal-use single-tenant
 * since the table is the user's own Postgres. A SHA-256 fingerprint
 * (`keyHash`) lives alongside so the UI can detect duplicates without
 * re-asking for the secret.
 *
 * `isBootstrap` is set for the key from `MINIMAX_API_KEY` env at boot; it's
 * undeletable and un-renamable, but can be disabled.
 */
export const minimaxKeys = pgTable(
  "minimax_keys",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** Secret (plaintext; table-internal). Used by the rotator. */
    secret: text("secret").notNull(),
    keyHash: text("key_hash").notNull(),
    /** Last 4 chars of the secret, for display: "sk-…abcd". */
    keyPrefix: text("key_prefix").notNull(),
    /** Optional user-supplied note ("main account", "side project", …). */
    keyHint: text("key_hint"),
    /** "active" | "disabled". `isBootstrap` rows can still be disabled. */
    status: text("status").notNull().default("active"),
    /** Total / successful calls. bigserial (auto-increment; default 0 isn't allowed so we set on insert). */
    requestsTotal: bigserial("requests_total", { mode: "bigint" }).notNull(),
    tokensInTotal: bigserial("tokens_in_total", { mode: "bigint" }).notNull(),
    tokensOutTotal: bigserial("tokens_out_total", { mode: "bigint" }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    lastErrorMsg: text("last_error_msg"),
    /** Consecutive failures; reset on success. Lets the UI surface
     *  "this key is broken" even if rate-limit cooldown hasn't fired. */
    consecutiveErrors: integer("consecutive_errors").notNull().default(0),
    /** Sliding window — the rotator skips this key until this time. */
    rateLimitedUntil: timestamp("rate_limited_until", { withTimezone: true }),
    isBootstrap: boolean("is_bootstrap").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    statusCheck: check(
      "minimax_keys_status_check",
      sql.raw(`"minimax_keys"."status" IN ('active','disabled')`),
    ),
    hashUnique: unique("minimax_keys_hash_unique").on(table.keyHash),
  }),
);

export type KeyRow = typeof minimaxKeys.$inferSelect;
export type NewKey = typeof minimaxKeys.$inferInsert;


/* -------------------------------------------------------------------------- */
/* App settings (singleton row, key="default")                                */
/* -------------------------------------------------------------------------- */

/**
 * Runtime config (base URL, default model). Persisted to the DB so the
 * UI is the single source of truth — env vars MINIMAX_BASE_URL and
 * MINIMAX_MODEL are no longer consulted. Singleton row keyed by "default".
 */
export const appSettings = pgTable(
  "app_settings",
  {
    key: text("key").primaryKey(),
    baseUrl: text("base_url").notNull(),
    defaultModel: text("default_model").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    urlCheck: check(
      "app_settings_url_check",
      sql.raw(
        "\"app_settings\".\"base_url\" ~ '^https?://[^\\s]+$'",
      ),
    ),
  }),
);

export type AppSettingsRow = typeof appSettings.$inferSelect;
export type NewAppSettings = typeof appSettings.$inferInsert;
