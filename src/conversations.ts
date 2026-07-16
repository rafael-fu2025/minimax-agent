// filepath: src/conversations.ts
import type { UiMessage } from "./types";

/**
 * Multi-conversation store backed by localStorage.
 * Keeps a list of conversations plus the id of the active one.
 * Each conversation is just an array of UiMessage.
 */

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: UiMessage[];
}

const STORAGE_KEY = "astryx-minimax-agent.conversations.v1";
const ACTIVE_KEY = "astryx-minimax-agent.activeConversation.v1";

export const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Build a short title from the first user message, or a placeholder. */
export function autoTitle(messages: UiMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "New conversation";
  const trimmed = firstUser.content.trim().replace(/\s+/g, " ");
  if (trimmed.length <= 40) return trimmed;
  return `${trimmed.slice(0, 37)}…`;
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                 */
/* -------------------------------------------------------------------------- */

interface PersistedShape {
  conversations: Conversation[];
}

function readPersisted(): PersistedShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { conversations: [] };
    const parsed = JSON.parse(raw) as PersistedShape;
    if (!Array.isArray(parsed.conversations)) {
      return { conversations: [] };
    }
    return parsed;
  } catch {
    return { conversations: [] };
  }
}

function writePersisted(state: PersistedShape) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore quota / private-mode errors.
  }
}

export function readActiveId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function writeActiveId(id: string) {
  try {
    localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    // Ignore.
  }
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function listConversations(): Conversation[] {
  return readPersisted().conversations.sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
}

export function loadConversation(id: string): Conversation | null {
  return readPersisted().conversations.find((c) => c.id === id) ?? null;
}

export function saveConversation(conv: Conversation) {
  const data = readPersisted();
  const idx = data.conversations.findIndex((c) => c.id === conv.id);
  if (idx === -1) data.conversations.push(conv);
  else data.conversations[idx] = conv;
  writePersisted(data);
}

export function deleteConversation(id: string) {
  const data = readPersisted();
  data.conversations = data.conversations.filter((c) => c.id !== id);
  writePersisted(data);
}

/**
 * Update the user-visible title of a conversation. Bumped `updatedAt` so
 * the sidebar resorts it to the top of the list. Returns the updated
 * conversation or `null` when nothing matched the id.
 */
export function renameConversation(id: string, title: string): Conversation | null {
  const data = readPersisted();
  const idx = data.conversations.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  const trimmed = title.trim();
  const next = trimmed || "New conversation";
  data.conversations[idx] = {
    ...data.conversations[idx],
    title: next,
    updatedAt: Date.now(),
  };
  writePersisted(data);
  return data.conversations[idx];
}

export function createConversation(initialMessages: UiMessage[]): Conversation {
  const now = Date.now();
  const conv: Conversation = {
    id: newId(),
    title: autoTitle(initialMessages),
    createdAt: now,
    updatedAt: now,
    messages: initialMessages,
  };
  saveConversation(conv);
  writeActiveId(conv.id);
  return conv;
}