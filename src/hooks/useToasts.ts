// filepath: src/hooks/useToasts.ts
import { useCallback, useRef, useState } from "react";

export type ToastVariant = "info" | "success" | "warning" | "error";

/**
 * User-supplied toast payload. The hook fills in `id`, `createdAt`, and
 * the default TTL.
 */
export interface ToastInput {
  variant?: ToastVariant;
  message: string;
  description?: string;
  /** Auto-dismiss after this many ms. 0 disables auto-dismiss. */
  ttlMs?: number;
  action?: { label: string; onClick: () => void };
}

export interface Toast extends Required<Pick<ToastInput, "variant">> {
  id: string;
  message: string;
  description?: string;
  createdAt: number;
  /** Auto-dismiss at this timestamp (Date.now() + ttl). 0 = sticky. */
  expiresAt: number;
  action?: { label: string; onClick: () => void };
}

export interface UseToastsReturn {
  toasts: Toast[];
  push: (input: ToastInput) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

/**
 * Lightweight, in-memory toast queue. Component-level state (lives in
 * the App shell); not a global store. Designed for ephemeral feedback
 * that does not need to persist across reloads.
 *
 * Behaviour:
 * - FIFO with a soft cap (default 5). Older toasts that exceed the cap
 *   are evicted so the host never overflows the viewport.
 * - Each toast gets a default 4s TTL. Use ttlMs=0 for sticky toasts
 *   (e.g. errors) which require explicit dismiss.
 * - The host owns its own ticking; this hook just emits state.
 */
/**
 * Append a toast to the existing list, enforcing the soft capacity cap by
 * evicting the oldest entry. Pure: deterministic, no React state involved,
 * so unit tests can drive it without a renderer.
 */
export function enqueueToast(prev: Toast[], next: Toast, max: number): Toast[] {
  if (max <= 0) return [next];
  const out = [...prev, next];
  if (out.length <= max) return out;
  return out.slice(out.length - max);
}

/**
 * Filter a toast list by id. Pure counterpart of the `dismiss` action.
 */
export function dismissToast(prev: Toast[], id: string): Toast[] {
  return prev.filter((t) => t.id !== id);
}

export function useToasts(opts?: { max?: number; defaultTtlMs?: number }): UseToastsReturn {
  const max = opts?.max ?? 5;
  const defaultTtlMs = opts?.defaultTtlMs ?? 4000;
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Used only to mint unique ids even across rapid pushes.
  const seqRef = useRef(0);

  const push = useCallback(
    (input: ToastInput) => {
      seqRef.current += 1;
      const now = Date.now();
      const ttl = input.ttlMs ?? defaultTtlMs;
      const t: Toast = {
        id: `t-${now}-${seqRef.current}` + Math.random().toString(36).slice(2, 6),
        variant: input.variant ?? "info",
        message: input.message,
        description: input.description,
        action: input.action,
        createdAt: now,
        expiresAt: ttl > 0 ? now + ttl : 0,
      };
      setToasts((prev) => enqueueToast(prev, t, max));
      return t.id;
    },
    [defaultTtlMs, max],
  );

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => dismissToast(prev, id));
  }, []);

  const clear = useCallback(() => {
    setToasts([]);
  }, []);

  return { toasts, push, dismiss, clear };
}

/**
 * Convenience helpers. Use the hook to call these inside a component.
 */
export type ToastKind = ToastVariant;
