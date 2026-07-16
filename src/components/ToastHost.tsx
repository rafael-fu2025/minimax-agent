// filepath: src/components/ToastHost.tsx
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import {
  BellIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleXIcon,
  InfoIcon,
  XIcon,
} from "lucide-react";
import type { Toast, ToastVariant } from "../hooks/useToasts";

export interface ToastHostProps {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}

const ICON_BY_VARIANT: Record<ToastVariant, typeof InfoIcon> = {
  info: InfoIcon,
  success: CircleCheckIcon,
  warning: CircleAlertIcon,
  error: CircleXIcon,
};

/**
 * Renders the toast stack inside a portal attached to `document.body`.
 * The stack anchors bottom-right; the order in `toasts` is preserved so
 * the most recent push appears closest to the bottom edge.
 *
 * Each toast self-dismisses when its `expiresAt` passes. Sticky toasts
 * (expiresAt === 0) require the explicit close button.
 */
export function ToastHost({ toasts, onDismiss }: ToastHostProps) {
  return createPortal(
    <div className="toast-host" role="region" aria-label="Notifications">
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>,
    document.body,
  );
}

interface ToastProps {
  toast: Toast;
  onDismiss: (id: string) => void;
}

function Toast({ toast, onDismiss }: ToastProps) {
  // Schedule a dismiss when the toast expires. Cleanup handles the
  // usual unmount-during-push case.
  useEffect(() => {
    if (toast.expiresAt === 0) return;
    const remaining = toast.expiresAt - Date.now();
    if (remaining <= 0) {
      onDismiss(toast.id);
      return;
    }
    const t = window.setTimeout(() => onDismiss(toast.id), remaining);
    return () => window.clearTimeout(t);
  }, [toast.id, toast.expiresAt, onDismiss]);

  const IconComp = ICON_BY_VARIANT[toast.variant] ?? BellIcon;

  return (
    <div
      className={`toast toast--${toast.variant}${toast.action ? " toast--with-action" : ""}`}
      role="status"
    >
      <span className="toast__icon" aria-hidden="true">
        <Icon icon={IconComp} size="md" />
      </span>
      <div className="toast__body">
        <span className="toast__message">{toast.message}</span>
        {toast.description && (
          <span className="toast__description">{toast.description}</span>
        )}
      </div>
      {toast.action && (
        <button
          type="button"
          className="toast__action"
          onClick={() => {
            toast.action!.onClick();
            onDismiss(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      )}
      <IconButton
        label="Dismiss"
        size="sm"
        variant="ghost"
        onClick={() => onDismiss(toast.id)}
        icon={<Icon icon={XIcon} size="sm" />}
      />
    </div>
  );
}
