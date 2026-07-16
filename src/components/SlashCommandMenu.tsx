// filepath: src/components/SlashCommandMenu.tsx
import { useEffect, useRef } from "react";
import { Icon } from "@astryxdesign/core/Icon";
import { CornerDownLeftIcon, SearchIcon } from "lucide-react";
import type { SlashCommand, SlashFilter } from "../slashCommands";

export interface SlashCommandMenuProps {
  filter: SlashFilter;
  onSelect: (cmd: SlashCommand) => void;
  onHighlight: (nextIndex: number) => void;
  onClose: () => void;
}

/**
 * Floating menu shown above the composer when the user types a `/` token.
 *
 * Renders inside a positioned wrapper that the composer slots in next to
 * the input area. Anchored bottom-left so it sits naturally above the
 * `+` upload button. Up to 8 rows visible, scrollable for the rest.
 */
export function SlashCommandMenu({
  filter,
  onSelect,
  onHighlight,
  onClose,
}: SlashCommandMenuProps) {
  const listRef = useRef<HTMLDivElement | null>(null);

  // Keep the highlighted row in view as it moves under the cursor or arrow
  // keys. We don't auto-scroll on first mount; only when the user moves
  // the highlight.
  useEffect(() => {
    const root = listRef.current;
    if (!root) return;
    const row = root.querySelector<HTMLElement>(
      `[data-slash-index="${filter.highlighted}"]`,
    );
    row?.scrollIntoView({ block: "nearest" });
  }, [filter.highlighted]);

  // Outside click closes the menu. We deliberately listen for `mousedown`
  // so a click that lands inside the menu bubbles up and our handler
  // doesn't fire before the menu's own click handler does.
  useEffect(() => {
    const onDocPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (listRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, [onClose]);

  return (
    <div
      ref={listRef}
      className="slash-menu"
      role="listbox"
      aria-label="Slash commands"
      data-testid="slash-menu"
    >
      <div className="slash-menu__header">
        <Icon icon={SearchIcon} size="sm" />
        <span>Commands</span>
        <span className="slash-menu__query">{filter.query || "/"}</span>
      </div>
      <div className="slash-menu__list">
        {filter.matches.map((cmd, i) => {
          const isActive = i === filter.highlighted;
          return (
            <button
              type="button"
              key={cmd.slug}
              role="option"
              aria-selected={isActive}
              data-slash-index={i}
              className={`slash-menu__row${
                isActive ? " slash-menu__row--active" : ""
              }`}
              onMouseEnter={() => onHighlight(i)}
              onClick={() => onSelect(cmd)}
            >
              <span className="slash-menu__slug">{cmd.slug}</span>
              <span className="slash-menu__body">
                <span className="slash-menu__label">{cmd.label}</span>
                <span className="slash-menu__description">
                  {cmd.description}
                </span>
              </span>
              {cmd.keybinding ? (
                <span className="slash-menu__key" aria-hidden="true">
                  {cmd.keybinding === "Enter" ? (
                    <Icon icon={CornerDownLeftIcon} size="sm" />
                  ) : (
                    cmd.keybinding
                  )}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}