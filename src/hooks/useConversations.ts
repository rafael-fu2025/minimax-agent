/**
 * `useConversations` — localStorage-backed multi-conversation store.
 *
 * Owns:
 *   - the list of saved conversations (sidebar)
 *   - the active conversation id
 *   - the messages of the active conversation
 *
 * Hydrates on mount from localStorage and seeds a fresh welcome conversation
 * when none exist. Writes back to localStorage on every change to keep the
 * sidebar ordered and reloads fast.
 *
 * The component decides what counts as a "welcome" message; pass it via
 * `welcome`. The hook is otherwise state-machine-free: callers mutate via
 * the returned setters.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  autoTitle,
  createConversation,
  deleteConversation,
  loadConversation,
  readActiveId,
  renameConversation,
  saveConversation,
  writeActiveId,
  type Conversation,
} from "../conversations";
import type { UiMessage } from "../types";

export interface UseConversationsOpts {
  /** First message to seed a fresh conversation with. */
  welcome: UiMessage;
}

export interface UseConversationsReturn {
  conversations: Conversation[];
  activeId: string | null;
  activeMessages: UiMessage[];
  /** Imperatively load a conversation by id. Aborts any in-flight stream
   *  through the `onSwitch` callback the caller wires up. */
  selectConversation: (id: string) => void;
  /** Start a fresh conversation. */
  startNew: () => Conversation;
  /**
   * Delete one conversation. If it was active, switch to the next one
   * (or seed a fresh welcome conversation when none remain). Returns the
   * deleted record so the caller can offer an Undo affordance.
   */
  remove: (id: string) => Conversation | null;
  /**
   * Rename a conversation. Trims, falls back to "New conversation" when
   * empty, and reorders it to the top of the sidebar. No-op when the id
   * is unknown. Returns the updated conversation or `null`.
   */
  rename: (id: string, title: string) => Conversation | null;
  /**
   * Restore a previously deleted conversation. The companion to `remove`:
   * callers capture the record returned by `remove` and pass it back
   * here to reinsert. Returns the id of the restored conversation, or
   * `null` if the conversation could not be written to storage.
   */
  restore: (conv: Conversation) => string | null;
  /**
   * Update the active conversation's messages in place. The hook also
   * persists the change to localStorage on the next render.
   */
  setActiveMessages: (
    updater: (prev: UiMessage[]) => UiMessage[],
  ) => void;
  /** True once the initial hydration from localStorage has completed. */
  hydrated: boolean;
}

export function useConversations(
  opts: UseConversationsOpts,
): UseConversationsReturn {
  const { welcome } = opts;
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeMessages, setActiveMessagesState] = useState<UiMessage[]>([welcome]);
  const [hydrated, setHydrated] = useState(false);
  // Tracks the last hydrated state so we don't persist during SSR-like
  // transitions. Once `hydrated` flips to true, every subsequent change
  // writes through.
  const skipPersistRef = useRef(true);

  /* ----------------- hydrate on mount ----------------- */
  useEffect(() => {
    try {
      const raw = localStorage.getItem("astryx-minimax-agent.conversations.v1");
      const existing: Conversation[] = raw
        ? (() => {
            try {
              const parsed = JSON.parse(raw) as { conversations?: Conversation[] };
              return Array.isArray(parsed.conversations)
                ? [...parsed.conversations].sort(
                    (a, b) => b.updatedAt - a.updatedAt,
                  )
                : [];
            } catch {
              return [];
            }
          })()
        : [];
      if (existing.length > 0) {
        const persistedActive = readActiveId();
        const target =
          existing.find((c) => c.id === persistedActive) ?? existing[0];
        setConversations(existing);
        setActiveId(target.id);
        setActiveMessagesState(target.messages);
        writeActiveId(target.id);
      } else {
        const conv = createConversation([welcome]);
        setConversations([conv]);
        setActiveId(conv.id);
        setActiveMessagesState(conv.messages);
      }
    } finally {
      skipPersistRef.current = false;
      setHydrated(true);
    }
    // welcome is a stable constant for the lifetime of the app — intentionally
    // not a dep. The hook seeds once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ----------------- persist on every change ----------------- */
  useEffect(() => {
    if (skipPersistRef.current) return;
    if (!activeId) return;
    // Preserve the conversation's original createdAt: rewriting it on every
    // persist collapses sort-by-age into sort-by-updatedAt, defeating the
    // sidebar's chronological ordering. Look up the existing row first;
    // fall back to "now" for the brand-new conversation case.
    const existing = conversations.find((c) => c.id === activeId);
    const conv: Conversation = {
      id: activeId,
      title:
        activeMessages.length > 1 ? autoTitle(activeMessages) : "New conversation",
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      messages: activeMessages,
    };
    saveConversation(conv);
    // Refresh the sidebar ordering whenever messages change.
    try {
      const raw = localStorage.getItem("astryx-minimax-agent.conversations.v1");
      if (raw) {
        const parsed = JSON.parse(raw) as { conversations: Conversation[] };
        if (Array.isArray(parsed.conversations)) {
          setConversations(
            [...parsed.conversations].sort(
              (a, b) => b.updatedAt - a.updatedAt,
            ),
          );
        }
      }
    } catch {
      // ignore — localStorage might not be available
    }
  }, [activeMessages, activeId]);

  /* ----------------- selectors ----------------- */
  const selectConversation = useCallback((id: string) => {
    const conv = loadConversation(id);
    if (!conv) return;
    setActiveId(conv.id);
    setActiveMessagesState(conv.messages);
    writeActiveId(conv.id);
  }, []);

  const startNew = useCallback((): Conversation => {
    const conv = createConversation([welcome]);
    setActiveId(conv.id);
    setActiveMessagesState(conv.messages);
    // Refresh sidebar ordering.
    try {
      const raw = localStorage.getItem("astryx-minimax-agent.conversations.v1");
      if (raw) {
        const parsed = JSON.parse(raw) as { conversations: Conversation[] };
        if (Array.isArray(parsed.conversations)) {
          setConversations(
            [...parsed.conversations].sort(
              (a, b) => b.updatedAt - a.updatedAt,
            ),
          );
        }
      }
    } catch {
      // ignore
    }
    return conv;
  }, [welcome]);

  const remove = useCallback(
    (id: string): Conversation | null => {
      // Capture the deleted record from React state BEFORE the underlying
      // store is mutated so the caller can offer an Undo affordance.
      const deleted = conversations.find((c) => c.id === id) ?? null;
      deleteConversation(id);
      let remaining: Conversation[] = [];
      try {
        const raw = localStorage.getItem("astryx-minimax-agent.conversations.v1");
        if (raw) {
          const parsed = JSON.parse(raw) as { conversations: Conversation[] };
          remaining = Array.isArray(parsed.conversations)
            ? [...parsed.conversations].sort(
                (a, b) => b.updatedAt - a.updatedAt,
              )
            : [];
        }
      } catch {
        remaining = [];
      }
      setConversations(remaining);
      if (id === activeId) {
        if (remaining.length > 0) {
          const next = remaining[0];
          setActiveId(next.id);
          setActiveMessagesState(next.messages);
          writeActiveId(next.id);
        } else {
          const conv = createConversation([welcome]);
          setConversations([conv]);
          setActiveId(conv.id);
          setActiveMessagesState(conv.messages);
        }
      }
      return deleted;
    },
    [activeId, conversations, welcome],
  );

  const setActiveMessages = useCallback(
    (updater: (prev: UiMessage[]) => UiMessage[]) => {
      setActiveMessagesState((prev) => updater(prev));
    },
    [],
  );

  const rename = useCallback(
    (id: string, title: string) => {
      const updated = renameConversation(id, title);
      if (!updated) return null;
      setConversations((prev) => {
        const others = prev.filter((c) => c.id !== id);
        return [updated, ...others];
      });
      return updated;
    },
    [],
  );

  const restore = useCallback((conv: Conversation): string | null => {
    try {
      saveConversation(conv);
    } catch {
      return null;
    }
    setConversations((prev) => {
      const without = prev.filter((c) => c.id !== conv.id);
      return [conv, ...without];
    });
    return conv.id;
  }, []);

  return {
    conversations,
    activeId,
    activeMessages,
    selectConversation,
    startNew,
    remove,
    rename,
    restore,
    setActiveMessages,
    hydrated,
  };
}

