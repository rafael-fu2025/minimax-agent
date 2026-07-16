/**
 * Repository functions for `conversations` and `messages`.
 *
 * Sequence allocation under concurrency: `appendMessage` takes a row-level
 * lock on the parent conversation (`SELECT ... FOR UPDATE`) so concurrent
 * appenders serialize, and is backed by `UNIQUE (conversation_id, sequence)`
 * for the rare case where two transactions slip through. A unique-violation
 * triggers an exponential-backoff retry (max 3 attempts).
 *
 * Every function here throws on error. Wrapping in try/catch is the
 * caller's responsibility (see `safePersistence` in `../persistence.ts`).
 */

import { and, asc, desc, eq, sql } from "drizzle-orm";
import { getDb } from "./index.js";
import {
  conversations,
  messages,
  type ConversationRow,
  type MessageRow,
} from "./schema.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuid(id: string, label = "id"): void {
  if (!UUID_RE.test(id)) {
    throw new Error(`Invalid ${label}: ${id}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export interface ConversationSummary {
  id: string;
  title: string;
  model: string | null;
  systemPrompt: string | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  messageCount: number;
}

export interface ConversationWithMessages extends ConversationSummary {
  messages: MessageRow[];
}

export interface CreateConversationInput {
  id?: string;
  title?: string;
  model?: string | null;
  systemPrompt?: string | null;
}

export interface AppendMessageInput {
  conversationId: string;
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  thinking?: string | null;
  toolCalls?: unknown | null;
  toolCallId?: string | null;
  toolName?: string | null;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null;
  /**
   * Multimodal content parts for a user message (text + image + video).
   * When the caller is persisting a multimodal message they should also pass
   * the joined plain-text into `content` so auto-title and memory indexing
   * keep working; the full parts array lives here for re-display.
   */
  attachments?: unknown | null;
}

function summarize(row: ConversationRow): ConversationSummary {
  return {
    id: row.id,
    title: row.title,
    model: row.model,
    systemPrompt: row.systemPrompt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    messageCount: row.messageCount,
  };
}

/* -------------------------------------------------------------------------- */
/* Conversations                                                              */
/* -------------------------------------------------------------------------- */

export async function createConversation(
  input: CreateConversationInput,
): Promise<ConversationSummary> {
  if (input.id) assertUuid(input.id, "conversation id");
  const db = getDb();
  const rows = await db
    .insert(conversations)
    .values({
      id: input.id ?? crypto.randomUUID(),
      title: input.title ?? "New conversation",
      model: input.model ?? null,
      systemPrompt: input.systemPrompt ?? null,
    })
    .returning();
  return summarize(rows[0]);
}

/**
 * Upsert by id. Used at the start of `POST /api/chat` so clients can mint
 * a conversation id locally without first calling POST /api/conversations.
 */
export async function ensureConversation(id: string): Promise<void> {
  assertUuid(id, "conversation id");
  const db = getDb();
  await db
    .insert(conversations)
    .values({ id, title: "New conversation" })
    .onConflictDoNothing();
}

export async function listConversations(opts: {
  limit: number;
  offset: number;
}): Promise<ConversationSummary[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(conversations)
    .orderBy(desc(conversations.updatedAt))
    .limit(opts.limit)
    .offset(opts.offset);
  return rows.map(summarize);
}

export async function getConversation(
  id: string,
): Promise<ConversationWithMessages | null> {
  assertUuid(id, "conversation id");
  const db = getDb();
  const convoRows = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);
  if (convoRows.length === 0) return null;
  const msgRows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(asc(messages.sequence));
  return { ...summarize(convoRows[0]), messages: msgRows };
}

export async function updateTitle(id: string, title: string): Promise<boolean> {
  assertUuid(id, "conversation id");
  const db = getDb();
  const result = await db
    .update(conversations)
    .set({ title, updatedAt: new Date() })
    .where(eq(conversations.id, id))
    .returning({ id: conversations.id });
  return result.length > 0;
}

export async function deleteConversation(id: string): Promise<boolean> {
  assertUuid(id, "conversation id");
  const db = getDb();
  const result = await db
    .delete(conversations)
    .where(eq(conversations.id, id))
    .returning({ id: conversations.id });
  return result.length > 0;
}

export async function setLastError(
  id: string,
  error: string | null,
): Promise<void> {
  assertUuid(id, "conversation id");
  const db = getDb();
  await db
    .update(conversations)
    .set({ lastError: error, updatedAt: new Date() })
    .where(eq(conversations.id, id));
}

/* -------------------------------------------------------------------------- */
/* Messages                                                                   */
/* -------------------------------------------------------------------------- */

export async function getMessageCount(id: string): Promise<number> {
  assertUuid(id, "conversation id");
  const db = getDb();
  const rows = await db
    .select({ mc: conversations.messageCount })
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);
  return rows[0]?.mc ?? 0;
}

/**
 * Append a message atomically. Holds a row-level lock on the parent
 * conversation so concurrent appends on the same id serialize, and is
 * backed by `UNIQUE (conversation_id, sequence)` for rare stragglers.
 *
 * Returns the inserted message row.
 */
export async function appendMessage(
  input: AppendMessageInput,
): Promise<MessageRow> {
  assertUuid(input.conversationId, "conversation id");
  const db = getDb();

  const maxAttempts = 3;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        // Row-level lock; released on commit/rollback.
        const lockRows = await tx
          .select({ mc: conversations.messageCount })
          .from(conversations)
          .where(eq(conversations.id, input.conversationId))
          .for("update");
        if (lockRows.length === 0) {
          throw new Error(
            `Conversation ${input.conversationId} does not exist`,
          );
        }
        const sequence = lockRows[0].mc;

        const inserted = await tx
          .insert(messages)
          .values({
            conversationId: input.conversationId,
            role: input.role,
            content: input.content ?? null,
            thinking: input.thinking ?? null,
            toolCalls: (input.toolCalls ?? null) as never,
            toolCallId: input.toolCallId ?? null,
            toolName: input.toolName ?? null,
            usage: (input.usage ?? null) as never,
            attachments: (input.attachments ?? null) as never,
            sequence,
          })
          .returning();
        const message = inserted[0];

        await tx
          .update(conversations)
          .set({
            messageCount: sql`${conversations.messageCount} + 1`,
            updatedAt: sql`now()`,
          })
          .where(eq(conversations.id, input.conversationId));

        // Clear lastError when a successful assistant turn lands. The
        // previous version added `eq(lastError, NULL)` here, which is always
        // `unknown` in SQL (NULL = NULL is not TRUE) and had no effect — so
        // we just match the conversation id.
        if (input.role === "assistant") {
          await tx
            .update(conversations)
            .set({ lastError: null })
            .where(eq(conversations.id, input.conversationId));
        }

        return message;
      });
    } catch (err) {
      lastError = err;
      const code = (err as { code?: string }).code;
      if (code !== "23505") throw err; // not a unique-violation; surface it
      // Exponential-ish backoff with jitter: 5 + random(0..20) ms, growing with attempts.
      const base = 5 + Math.floor(Math.random() * 20);
      const backoff = base * attempt;
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("appendMessage failed after retries");
}
