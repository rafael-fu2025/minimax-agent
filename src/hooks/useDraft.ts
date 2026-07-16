// filepath: src/hooks/useDraft.ts
import { useEffect, useRef, useState } from "react";

/**
 * Storage-key prefix. Exported so tests can mint keys for fixtures.
 */
export const KEY_PREFIX = "astryx-minimax-agent.draft.v1:";
/**
 * Default debounce window in milliseconds. Exported so tests can avoid
 * `vi.useFakeTimers()` and just override the per-call `delayMs` arg.
 */
export const DEBOUNCE_MS = 200;

export function readDraft(id: string): string {
  try {
    return localStorage.getItem(KEY_PREFIX + id) ?? "";
  } catch {
    return "";
  }
}

export function writeDraft(id: string, value: string) {
  try {
    if (value) {
      localStorage.setItem(KEY_PREFIX + id, value);
    } else {
      localStorage.removeItem(KEY_PREFIX + id);
    }
  } catch {
    // Ignore quota / private-mode errors. Best-effort persistence only.
  }
}

export interface UseDraftReturn {
  value: string;
  setValue: (next: string) => void;
  clear: () => void;
}

/**
 * Per-conversation composer draft, persisted to localStorage.
 *
 * The chat composer holds in-progress text. Without this hook, switching
 * threads or refreshing the page would drop the draft. Keying the draft
 * on the active conversation id lets each thread keep its own half-typed
 * message. Writes are debounced so a fast typist does not thrash storage.
 *
 * Usage:
 *   const { value, setValue, clear } = useDraft(activeId);
 *   <ChatComposer value={value} onChange={setValue} ... />
 */
export function useDraft(conversationId: string | null): UseDraftReturn {
  const [value, setValueState] = useState<string>(() =>
    conversationId ? readDraft(conversationId) : "",
  );
  // We keep the latest id in a ref so the debounced writer always reads
  // the most recent conversation id even if the user switches threads
  // mid-typing.
  const currentIdRef = useRef<string | null>(conversationId);
  const timerRef = useRef<number | null>(null);

  // When the conversation id changes, swap to the draft for the new id.
  useEffect(() => {
    currentIdRef.current = conversationId;
    const next = conversationId ? readDraft(conversationId) : "";
    setValueState(next);
  }, [conversationId]);

  // Flush any pending write when unmounting so nothing is lost.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const id = currentIdRef.current;
      if (id && value) {
        writeDraft(id, value);
      }
    };
    // We only care about unmount; `value` is captured via the closure
    // and any in-flight timer reads it at flush time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setValue = (next: string) => {
    setValueState(next);
    const id = currentIdRef.current;
    if (!id) return;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      // Re-read the id at flush time in case the user switched threads
      // while the debounce was pending.
      const target = currentIdRef.current ?? id;
      writeDraft(target, next);
    }, DEBOUNCE_MS);
  };

  const clear = () => {
    setValueState("");
    const id = currentIdRef.current;
    if (id) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      writeDraft(id, "");
    }
  };

  return { value, setValue, clear };
}

/**
 * Removes every stored draft. Returns the number removed, or 0 on storage
 * failure. Useful for the (optional) "Clear all drafts" admin action.
 */
export function clearAllDrafts(): number {
  let removed = 0;
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && key.startsWith(KEY_PREFIX)) {
        localStorage.removeItem(key);
        removed++;
      }
    }
  } catch {
    return 0;
  }
  return removed;
}
