// filepath: src/components/PermissionModeSelector.tsx
import { useEffect, useRef, useState } from "react";
import {
  ShieldCheckIcon,
  ShieldIcon,
  ShieldAlertIcon,
  CheckIcon,
} from "lucide-react";
import { Icon } from "@astryxdesign/core/Icon";
import type { PermissionMode } from "../types";

const STORAGE_KEY = "astryx.permissionMode.v1";

const VALID_MODES: readonly PermissionMode[] = ["safe", "accept-edits", "bypass"];

type ModeDef = {
  value: PermissionMode;
  title: string;
  description: string;
  /** Lucide icon component rendered on the leading edge of the row. */
  icon: typeof ShieldIcon;
};

const MODE_DEFS: readonly ModeDef[] = [
  {
    value: "safe",
    title: "Ask for approval",
    description: "Always ask to edit external files and use the internet",
    icon: ShieldAlertIcon,
  },
  {
    value: "accept-edits",
    title: "Approve for me",
    description: "Only ask for actions detected as potentially unsafe",
    icon: ShieldIcon,
  },
  {
    value: "bypass",
    title: "Full access",
    description: "Unrestricted access to the internet and any file on your computer",
    icon: ShieldCheckIcon,
  },
];

function readStoredMode(): PermissionMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "safe" || v === "accept-edits" || v === "bypass") return v;
  } catch {
    // ignore (private mode, etc.)
  }
  return "safe";
}

function writeStoredMode(mode: PermissionMode) {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // ignore
  }
}

interface PermissionModeSelectorProps {
  value: PermissionMode;
  onChange: (next: PermissionMode) => void;
  /** Disabled while a stream is running (changing mid-stream has no effect on the in-flight request). */
  isDisabled?: boolean;
}

/**
 * Compact mode selector that sits in the composer's `sendActions` slot.
 * Displays the active mode's title with a leading shield icon, and reveals
 * a dropdown of {title, description, icon} entries on click. Matches the
 * "Ask for approval / Approve for me / Full access" UX shown in the design.
 *
 * The underlying storage value still uses `safe | accept-edits | bypass` so
 * the rest of the app (server-side approval prompts) keeps working unchanged.
 */
export function PermissionModeSelector({
  value,
  onChange,
  isDisabled,
}: PermissionModeSelectorProps) {
  // Hydrate from localStorage on first mount so the rendered default matches
  // the persisted value.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  useEffect(() => {
    if (!hydrated) return;
    writeStoredMode(value);
  }, [value, hydrated]);

  const [isOpen, setIsOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [isOpen]);

  const active = MODE_DEFS.find((m) => m.value === value) ?? MODE_DEFS[0];
  const isBypass = value === "bypass";

  const handleSelect = (next: PermissionMode) => {
    setIsOpen(false);
    onChange(next);
    triggerRef.current?.focus();
  };

  return (
    <div className="permission-mode-selector" ref={popoverRef}>
      <button
        ref={triggerRef}
        type="button"
        className={
          "permission-mode-selector__trigger" +
          (isBypass ? " permission-mode-selector__trigger--bypass" : "")
        }
        onClick={() => setIsOpen((v) => !v)}
        disabled={isDisabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label="Permission mode"
      >
        <span className="permission-mode-selector__trigger-icon">
          <Icon icon={active.icon} size="sm" />
        </span>
        <span className="permission-mode-selector__trigger-label">
          {active.title}
        </span>
        <span className="permission-mode-selector__trigger-chevron" aria-hidden>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path
              d="M2 4l3 3 3-3"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>

      {isOpen && (
        <div
          className="permission-mode-selector__menu"
          role="listbox"
          aria-label="Permission mode"
        >
          {MODE_DEFS.map((m) => {
            const selected = m.value === value;
            return (
              <button
                key={m.value}
                type="button"
                role="option"
                aria-selected={selected}
                className={
                  "permission-mode-selector__option" +
                  (selected ? " is-selected" : "") +
                  (m.value === "bypass"
                    ? " permission-mode-selector__option--bypass"
                    : "")
                }
                onClick={() => handleSelect(m.value)}
              >
                <span className="permission-mode-selector__option-icon">
                  <Icon icon={m.icon} size="sm" />
                </span>
                <span className="permission-mode-selector__option-body">
                  <span className="permission-mode-selector__option-title">
                    {m.title}
                  </span>
                  <span className="permission-mode-selector__option-desc">
                    {m.description}
                  </span>
                </span>
                {selected && (
                  <span
                    className="permission-mode-selector__option-check"
                    aria-hidden
                  >
                    <CheckIcon size={14} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export { readStoredMode as readPersistedPermissionMode };