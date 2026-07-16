// filepath: src/components/MultimodalComposer.tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { ChatComposer } from "@astryxdesign/core/Chat";
import { Icon } from "@astryxdesign/core/Icon";
import {
  PlusIcon,
  ImageIcon,
  VideoIcon,
  FileTextIcon,
  AudioLinesIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import type { AttachmentMeta, ContentPart } from "../types";
import { uploadFile } from "../api";
import {
  AttachmentList,
  M3_LIMITS,
  readFileAsDataUrl,
  validateAttachment,
} from "./AttachmentList";
import { rasterizePdf } from "./pdfRasterize";
import { SlashCommandMenu } from "./SlashCommandMenu";
import {
  applyCommand,
  filterCommands,
  type SlashCommand,
  type SlashFilter,
} from "../slashCommands";

/* -------------------------------------------------------------------------- */
/* Types                                                                        */
/* -------------------------------------------------------------------------- */

export interface MultimodalComposerProps {
  /** Forwarded straight to the underlying ChatComposer. */
  placeholder: string;
  isDisabled: boolean;
  isStopShown: boolean;
  /**
   * Called when the user submits. Receives the typed text (already trimmed)
   * and the assembled `ContentPart[]` (text + attachments). Empty text + no
   * attachments is filtered by the caller.
   */
  onSubmit: (text: string, attachments: ContentPart[]) => void | Promise<void>;
  onStop: () => void;
  /** The `sendActions` slot from ChatComposer — we wrap it with a + button. */
  sendActions?: ReactNode;
  /**
   * After a successful send we call this with the just-submitted attachments
   * so the parent can clear its local state.
   */
  onAttachmentsSent?: (ids: string[]) => void;
  /**
   * Fired whenever the attachment list changes (add/remove). Lets the parent
   * hold onto the underlying `File` references so they can be uploaded via
   * the Files API proxy on send.
   */
  onAttachmentsChange?: (attachments: AttachmentMeta[]) => void;
  /**
   * Controlled value forwarded to the inner ChatComposer. When provided
   * alongside `onValueChange`, the composer becomes a controlled input —
   * useful for persisting drafts between conversation switches.
   */
  value?: string;
  onValueChange?: (next: string) => void;
  /**
   * Fired after a successful submit, once attachments have been cleared.
   * The parent uses this hook to clear the persisted draft.
   */
  onAfterSubmit?: () => void;
  /**
   * Fired when the user activates a slash command. The composer has
   * already applied any text replacement; the parent only needs to
   * handle "action" commands (e.g. /clear, /rename, /help).
   */
  onSlashCommand?: (cmd: SlashCommand, args: string) => void;
}

/* -------------------------------------------------------------------------- */
/* Component                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Wraps Astryx's <ChatComposer> with:
 *  - A circular "+" button (visually matched to the send button) that opens
 *    a popup menu for choosing the upload category (image / video / audio /
 *    document). Each category opens a file picker scoped to its MIME family.
 *  - Drag-and-drop on the composer area.
 *  - A horizontal strip of attachment chips above the composer.
 *  - Inline rendering of small images / videos, and Files API proxy upload
 *    for >50 MB videos.
 *
 * The wrapper keeps the original ChatComposer in charge of text input,
 * history, send button, and stop button. It just adds multimodal state.
 */
export function MultimodalComposer({
  placeholder,
  isDisabled,
  isStopShown,
  onSubmit,
  onStop,
  sendActions,
  onAttachmentsSent,
  onAttachmentsChange,
  value,
  onValueChange,
  onAfterSubmit,
  onSlashCommand,
}: MultimodalComposerProps) {
  const [attachments, setAttachments] = useState<AttachmentMeta[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const audioInputRef = useRef<HTMLInputElement | null>(null);
  const docInputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  /**
   * Outer wrapper that hosts the Astryx <ChatComposer>. We use it to locate the
   * underlying contentEditable textbox when we want to programmatically focus
   * the composer (initial mount and after a stream completes).
   */
  const inputWrapRef = useRef<HTMLDivElement | null>(null);
  const dragCounter = useRef(0);
  /**
   * Slash command palette state. Recomputed every time the value
   * changes; the menu is rendered as a sibling of the input area so
   * it floats above the composer body.
   */
  const [slashFilter, setSlashFilter] = useState<SlashFilter | null>(null);
  // Wrap a setter that updates both React state and triggers a re-render
  // even when the new filter is structurally identical (e.g. user moves
  // the highlight with arrow keys). Returning a fresh object each time
  // means useEffect dependencies fire correctly.
  const updateSlashHighlight = useCallback((idx: number) => {
    setSlashFilter((prev) =>
      prev && prev.matches
        ? { ...prev, highlighted: idx }
        : prev,
    );
  }, []);
  const closeSlashMenu = useCallback(() => setSlashFilter(null), []);
  /**
   * Activate the highlighted command. Applies any text replacement,
   * forwards the command to the parent, and closes the menu.
   */
  const activateSlashCommand = useCallback(
    (cmd: SlashCommand) => {
      const text = value ?? "";
      const next = applyCommand(text, cmd);
      onValueChange?.(next);
      // For action commands that accept args (e.g. /rename <title>) the
      // active token is `/rename <title>` with whitespace; the args
      // portion is everything after the slug. For everything else the
      // active token is just the slug and there are no args.
      let args = "";
      if (cmd.acceptsArgs) {
        const lastSpace = Math.max(
          text.lastIndexOf(" "),
          text.lastIndexOf("\n"),
        );
        const active = text.slice(lastSpace + 1);
        args = active.slice(cmd.slug.length).trim();
      }
      onSlashCommand?.(cmd, args);
      setSlashFilter(null);
    },
    [onSlashCommand, onValueChange, value],
  );

  /* --------------------------- file intake ---------------------------- */

  const addFiles = useCallback(
    async (incoming: FileList | File[]) => {
      const list = Array.from(incoming);
      const next: (AttachmentMeta & { file: File })[] = [];
      const nextErrors: Record<string, string> = {};
      for (const file of list) {
        const id = `${file.name}:${file.size}:${file.lastModified}:${Math.random()
          .toString(36)
          .slice(2, 8)}`;
        const validation = validateAttachment(file);
        if (!validation.ok) {
          nextErrors[id] = validation.error ?? "Invalid file";
          next.push({
            id,
            name: file.name,
            mime: file.type || "application/octet-stream",
            size: file.size,
            kind: "other",
            file,
          });
          continue;
        }
        const previewUrl =
          file.type.startsWith("image/") || file.type.startsWith("video/")
            ? URL.createObjectURL(file)
            : undefined;
        next.push({
          id,
          name: file.name,
          mime: file.type || "application/octet-stream",
          size: file.size,
          kind: previewUrl
            ? file.type.startsWith("image/")
              ? "image"
              : "video"
            : file.type === "application/pdf"
              ? "pdf"
              : "other",
          previewUrl,
          file,
        });
      }
      setAttachments((prev) => {
        const merged = [...prev, ...next];
        onAttachmentsChange?.(merged);
        return merged;
      });
      setErrors((prev) => ({ ...prev, ...nextErrors }));
    },
    [onAttachmentsChange],
  );

  const removeAttachment = useCallback(
    (id: string) => {
      setAttachments((prev) => {
        const next = prev.filter((a) => a.id !== id);
        onAttachmentsChange?.(next);
        return next;
      });
      setErrors((prev) => {
        const { [id]: _gone, ...rest } = prev;
        return rest;
      });
    },
    [onAttachmentsChange],
  );

  const handleSubmit = useCallback(
    async (text: string) => {
      if (isDisabled || uploading) return;
      const trimmed = text.trim();
      const hasAttachments = attachments.length > 0;
      if (trimmed.length === 0 && !hasAttachments) return;

      setUploading(true);
      try {
        const parts: ContentPart[] = [];
        let pdfNote = "";
        for (const a of attachments) {
          if (!a.file) continue;
          if (a.kind === "image" && a.file) {
            try {
              const url = await readFileAsDataUrl(a.file);
              parts.push({ type: "image_url", image_url: { url, detail: "default" } });
            } catch (err) {
              throw new Error(
                `Could not read image "${a.name}": ${(err as Error).message}`,
              );
            }
            continue;
          }
          if (a.kind === "video" && a.file) {
            try {
              if (a.file.size <= M3_LIMITS.videoBase64MaxBytes) {
                const url = await readFileAsDataUrl(a.file);
                parts.push({
                  type: "video_url",
                  video_url: { url, fps: 1 },
                });
              } else {
                // Defer to the Files API proxy by emitting a placeholder.
                parts.push({
                  type: "video_url",
                  video_url: { url: `__upload:${a.id}`, fps: 1 },
                });
              }
            } catch (err) {
              throw new Error(
                `Could not read video "${a.name}": ${(err as Error).message}`,
              );
            }
            continue;
          }
          if (a.kind === "pdf" && a.file) {
            try {
              const pages = await rasterizePdf(a.file, { maxPages: 4, scale: 1.5 });
              for (const p of pages) {
                parts.push({
                  type: "image_url",
                  image_url: { url: p.dataUrl, detail: "default" },
                });
              }
              if (trimmed.length === 0) {
                pdfNote = `Attached PDF "${a.name}" (${pages.length} page${pages.length === 1 ? "" : "s"}).`;
              } else {
                pdfNote = `[Attached PDF "${a.name}" (${pages.length} page${pages.length === 1 ? "" : "s"})]`;
              }
            } catch (err) {
              throw new Error(
                `Could not read PDF "${a.name}": ${(err as Error).message}`,
              );
            }
            continue;
          }
        }

        await onSubmit(pdfNote ? `${pdfNote}\n${trimmed}` : trimmed, parts);
        if (onAttachmentsSent) onAttachmentsSent(attachments.map((a) => a.id));
        if (onAfterSubmit) onAfterSubmit();
        for (const a of attachments) {
          if (a.previewUrl) {
            try {
              URL.revokeObjectURL(a.previewUrl);
            } catch {
              // ignore
            }
          }
        }
        setAttachments([]);
        setErrors({});
      } finally {
        setUploading(false);
      }
    },
    [attachments, isDisabled, onAfterSubmit, onAttachmentsSent, onSubmit, onValueChange, uploading],
  );

  /* --------------------------- picker --------------------------------- */

  const openPicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const pickCategory = useCallback(
    (category: "image" | "video" | "audio" | "document") => {
      setIsMenuOpen(false);
      // Defer the .click() until after the menu unmounts so the picker dialog
      // isn't bound to a stale parent.
      queueMicrotask(() => {
        const ref =
          category === "image"
            ? imageInputRef
            : category === "video"
              ? videoInputRef
              : category === "audio"
                ? audioInputRef
                : docInputRef;
        ref.current?.click();
      });
    },
    [],
  );

  const onPickerChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        void addFiles(files);
      }
      // Reset the input so the same file can be re-picked after removal.
      e.target.value = "";
    },
    [addFiles],
  );

  /* --------------------------- drag-and-drop --------------------------- */

  const onDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current += 1;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDragging(true);
    }
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setIsDragging(false);
    }
  }, []);

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      void addFiles(files);
    }
  }, [addFiles]);

  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      const items = e.clipboardData.items;
      if (!items) return;
      const files: File[] = [];
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (item.kind === "file") {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0) {
        void addFiles(files);
      }
    },
    [addFiles],
  );

  // Close the upload popup on outside click / Escape.
  useEffect(() => {
    if (!isMenuOpen) return;
    // Use the menu+trigger wrapper as the "inside" region so that any click
    // outside of it (including on the textarea, the chips, the page chrome)
    // dismisses the popup. The previous rootRef-based check excluded the
    // entire composer and only closed on clicks outside the widget, which felt
    // inconsistent with how menu popovers are expected to behave.
    const onDocPointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [isMenuOpen]);

  // Keep focus in the composer after streaming completes. We focus the
  // Astryx contentEditable textbox whenever (a) the wrapper mounts and
  // (b) the disabled flag flips from true to false (i.e. the AI just finished
  // a response). The user can then type their next message without having to
  // click the textarea first. We never steal focus while the composer is
  // disabled, so the stop button and per-turn updates don't get hijacked.
  const prevDisabledRef = useRef<boolean>(isDisabled || uploading);
  useEffect(() => {
    const wrap = inputWrapRef.current;
    if (!wrap) return;
    const textbox = wrap.querySelector<HTMLElement>("[role=\"textbox\"]");
    const isLocked = isDisabled || uploading;
    const wasLocked = prevDisabledRef.current;
    prevDisabledRef.current = isLocked;
    if (isLocked) return;
    if (wasLocked || !textbox) {
      textbox?.focus({ preventScroll: true });
    }
  }, [isDisabled, uploading]);
  // Recompute the slash-command palette every time the value changes.
  // A `null` result closes the menu; a non-null result opens (or updates)
  // it. The hook intentionally does not depend on `onValueChange`; it
  // derives from `value` alone.
  useEffect(() => {
    if (isDisabled || uploading) {
      setSlashFilter(null);
      return;
    }
    const filter = filterCommands({ text: value ?? "" });
    setSlashFilter(filter);
  }, [isDisabled, uploading, value]);

  // Revoke any preview URLs when the component unmounts OR whenever an
  // attachment is removed. The previous version captured `attachments` at
  // mount time (deps `[]`), so on unmount the cleanup iterated over an
  // empty array and leaked every preview URL the user attached during the
  // composer's lifetime. We snapshot the URL set into a ref and revoke on
  // unmount from there.
  const previewUrlsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const a of attachments) {
      if (a.previewUrl) previewUrlsRef.current.add(a.previewUrl);
    }
    return () => {
      for (const url of previewUrlsRef.current) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }
      previewUrlsRef.current.clear();
    };
  }, [attachments]);

  return (
    <div
      ref={rootRef}
      className={`multimodal-composer${isDragging ? " is-dragging" : ""}`}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onPaste={onPaste}
    >
      <section className="multimodal-composer__chips" aria-label="Attachments">
        <AttachmentList
          attachments={attachments}
          errors={errors}
          onRemove={removeAttachment}
        />
      </section>

      {isDragging && (
        <div className="multimodal-composer__dropzone" aria-hidden>
          <span>Drop files to attach</span>
        </div>
      )}

      <section className="multimodal-composer__composer">
        {/* Hidden file inputs — one per upload category, plus one for the
            "drag everything in" path used by the deprecated openPicker(). */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,video/*,audio/*,application/pdf"
          onChange={onPickerChange}
          className="multimodal-composer__file-input"
          tabIndex={-1}
          aria-hidden
          data-category="all"
        />
        <input
          ref={imageInputRef}
          type="file"
          multiple
          accept="image/*"
          onChange={onPickerChange}
          className="multimodal-composer__file-input"
          tabIndex={-1}
          aria-hidden
          data-category="image"
        />
        <input
          ref={videoInputRef}
          type="file"
          multiple
          accept="video/*"
          onChange={onPickerChange}
          className="multimodal-composer__file-input"
          tabIndex={-1}
          aria-hidden
          data-category="video"
        />
        <input
          ref={audioInputRef}
          type="file"
          multiple
          accept="audio/*"
          onChange={onPickerChange}
          className="multimodal-composer__file-input"
          tabIndex={-1}
          aria-hidden
          data-category="audio"
        />
        <input
          ref={docInputRef}
          type="file"
          multiple
          accept="application/pdf,.pdf,.doc,.docx,.txt,.md,.rtf"
          onChange={onPickerChange}
          className="multimodal-composer__file-input"
          tabIndex={-1}
          aria-hidden
          data-category="document"
        />


        <div ref={inputWrapRef} className="multimodal-composer__composer-input">
          <ChatComposer
            placeholder={placeholder}
            isDisabled={isDisabled || uploading}
            isStopShown={isStopShown}
            onSubmit={handleSubmit}
            onStop={onStop}
            sendActions={sendActions}
            value={value}
            onChange={onValueChange}
          />
        </div>
        <div ref={menuRef} className="multimodal-composer__attach">
          <button
            type="button"
            className="multimodal-composer__add"
            onClick={() => setIsMenuOpen((v) => !v)}
            disabled={isDisabled || uploading}
            aria-label="Add attachment"
            aria-haspopup="menu"
            aria-expanded={isMenuOpen}
            title="Add attachment"
          >
            <Icon icon={PlusIcon} size="md" />
          </button>
          {isMenuOpen && (
            <div
              className="multimodal-composer__upload-menu"
              role="menu"
              aria-label="Upload"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                role="menuitem"
                className="multimodal-composer__upload-item"
                onClick={() => pickCategory("image")}
              >
                <Icon icon={ImageIcon} size="sm" />
                <span>Image</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="multimodal-composer__upload-item"
                onClick={() => pickCategory("video")}
              >
                <Icon icon={VideoIcon} size="sm" />
                <span>Video</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="multimodal-composer__upload-item"
                onClick={() => pickCategory("audio")}
              >
                <Icon icon={AudioLinesIcon} size="sm" />
                <span>Audio</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="multimodal-composer__upload-item"
                onClick={() => pickCategory("document")}
              >
                <Icon icon={FileTextIcon} size="sm" />
                <span>Document</span>
              </button>
            </div>
          )}
        </div>
      </section>

      {/* Slash command palette. Floats above the composer body. The
          keyboard map is wired through the input wrapper so arrow keys,
          Enter, and Escape work even though Astryx contentEditable
          does not expose a controlled keydown handler. */}
      {slashFilter && slashFilter.matches.length > 0 && (
        <SlashCommandMenu
          filter={slashFilter}
          onSelect={activateSlashCommand}
          onHighlight={updateSlashHighlight}
          onClose={closeSlashMenu}
        />
      )}

      {/* Keyboard handler (invisible). Attached to the input wrap so
          other textboxes (e.g. the rename input) are unaffected. */}
      <SlashCommandKeyHandler
        inputWrapRef={inputWrapRef}
        slashFilter={slashFilter}
        onHighlight={updateSlashHighlight}
        onActivate={activateSlashCommand}
        onClose={closeSlashMenu}
      />

      <section className="multimodal-composer__status" aria-live="polite">
        {uploading && (
          <span className="multimodal-composer__uploading">
            Preparing attachments…
          </span>
        )}
      </section>
    </div>
  );
}

/**
 * Listens for arrow / Enter / Escape while the user is typing in the
 * composer. Only acts when the slash menu is open; otherwise the
 * keystrokes fall through to the Astryx contentEditable and the native
 * keydown behaviour (e.g. newlines on Shift+Enter) keeps working.
 */
function SlashCommandKeyHandler({
  inputWrapRef,
  slashFilter,
  onHighlight,
  onActivate,
  onClose,
}: {
  inputWrapRef: React.RefObject<HTMLElement | null>;
  slashFilter: SlashFilter | null;
  onHighlight: (next: number) => void;
  onActivate: (cmd: SlashCommand) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!slashFilter || slashFilter.matches.length === 0) return;
    const wrap = inputWrapRef.current;
    if (!wrap) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = (slashFilter.highlighted + 1) % slashFilter.matches.length;
        onHighlight(next);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const next = (slashFilter.highlighted - 1 + slashFilter.matches.length) %
          slashFilter.matches.length;
        onHighlight(next);
      } else if (e.key === "Enter" && !e.shiftKey) {
        const cmd = slashFilter.matches[slashFilter.highlighted];
        if (cmd) {
          e.preventDefault();
          onActivate(cmd);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    wrap.addEventListener("keydown", onKey);
    return () => wrap.removeEventListener("keydown", onKey);
  }, [inputWrapRef, onActivate, onClose, onHighlight, slashFilter]);
  return null;
}
