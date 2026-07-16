// filepath: src/components/SidebarConversationRow.tsx
import { useEffect, useRef, useState } from "react";
import { SideNavItem } from "@astryxdesign/core/SideNav";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import {
  CheckIcon,
  MessageCircleIcon,
  PencilIcon,
  TrashIcon,
  XIcon,
} from "lucide-react";

export interface SidebarConversationRowProps {
  id: string;
  title: string;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => unknown;
  onNotify: (input: {
    variant: "success" | "warning" | "error";
    message: string;
    description?: string;
  }) => void;
}

/**
 * A single conversation row in the sidebar.
 *
 * - Click the title to switch threads.
 * - Hover to reveal the Rename (pencil) and Delete (trash) buttons.
 * - Click Rename to enter an inline edit. Enter or blur commits;
 *   Esc cancels; an empty value reverts to the existing title.
 *
 * The row owns its edit-mode state but defers persistence to the parent
 * via `onRename`. That keeps the rename UX identical to the rest of the
 * app and makes the row trivial to unit-test.
 */
export function SidebarConversationRow({
  id,
  title,
  isSelected,
  onSelect,
  onDelete,
  onRename,
  onNotify,
}: SidebarConversationRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Re-sync local draft if the canonical title changes underneath us
  // (e.g. the conversation is renamed from elsewhere, or the messages
  // update the auto-generated title).
  useEffect(() => {
    if (!isEditing) setDraft(title);
  }, [title, isEditing]);

  // Autofocus + select the text when entering edit mode so the user can
  // immediately retype or extend the title.
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const commit = () => {
    const next = draft.trim();
    setIsEditing(false);
    if (next === "") {
      setDraft(title);
      return;
    }
    if (next === title) return;
    const result = onRename(id, next);
    if (result === false) {
      // Caller signaled failure; revert the input so the user can try again.
      setDraft(title);
      onNotify({
        variant: "warning",
        message: "Could not rename conversation",
      });
    }
  };

  const cancel = () => {
    setDraft(title);
    setIsEditing(false);
  };

  if (isEditing) {
    return (
      <div className="side-row side-row--editing">
        <input
          ref={inputRef}
          type="text"
          className="side-row__rename-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          onBlur={commit}
          maxLength={120}
          aria-label="Conversation title"
        />
        <IconButton
          label="Save title"
          size="sm"
          variant="ghost"
          onMouseDown={(e) => e.preventDefault() /* keep input focused */}
          onClick={commit}
          icon={<Icon icon={CheckIcon} size="sm" />}
        />
        <IconButton
          label="Cancel rename"
          size="sm"
          variant="ghost"
          onMouseDown={(e) => e.preventDefault()}
          onClick={cancel}
          icon={<Icon icon={XIcon} size="sm" />}
        />
      </div>
    );
  }

  return (
    <div className={`side-row${isSelected ? " side-row--selected" : ""}`}>
      <SideNavItem
        label={title || "New conversation"}
        isSelected={isSelected}
        onClick={() => onSelect(id)}
        icon={MessageCircleIcon}
      />
      <IconButton
        label="Rename conversation"
        size="sm"
        variant="ghost"
        className="side-row__rename"
        onClick={() => setIsEditing(true)}
        icon={<Icon icon={PencilIcon} size="sm" />}
      />
      <IconButton
        label="Delete conversation"
        size="sm"
        variant="ghost"
        className="side-row__delete"
        onClick={() => onDelete(id)}
        icon={<Icon icon={TrashIcon} size="sm" />}
      />
    </div>
  );
}
