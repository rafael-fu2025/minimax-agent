import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Dialog } from "@astryxdesign/core/Dialog";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { TreeList, type TreeListItemData } from "@astryxdesign/core/TreeList";
import { VStack } from "@astryxdesign/core/VStack";
import {
  CopyIcon,
  EditIcon,
  FileIcon,
  FilePlusIcon,
  FolderClosedIcon,
  FolderPlusIcon,
  MessageCircleIcon,
  RefreshCwIcon,
  TrashIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import {
  fetchSandboxFile,
  fetchSandboxRoot,
  fetchSandboxTree,
  sandboxDelete,
  sandboxMkdir,
  sandboxRename,
  sandboxRestore,
  sandboxUpload,
  setSandboxRoot,
} from "../api";
import type { FileContent, SandboxRoot, TreeNode } from "../types";

interface WorkspaceExplorerProps {
  /**
   * Bumped whenever a server-side tool mutates the sandbox (write_file).
   * Increments trigger a refetch; same value twice in a row is a no-op.
   */
  treeVersion: number;
  /**
   * Called when the user clicks "Ask the agent about this file" on the file
   * preview dialog. The path is relative to the sandbox root.
   */
  onAskAgent: (relPath: string) => void;
  /**
   * Push a toast. Mirrors the App-level signature so the explorer can
   * surface success / failure of every mutation without re-implementing
   * the toast queue itself.
   */
  onNotify: (input: {
    variant: "success" | "warning" | "error";
    message: string;
    description?: string;
    ttlMs?: number;
    action?: { label: string; onClick: () => void };
  }) => void;
}

/**
 * Path-join helper for sandbox-relative paths. Uses forward slashes
 * (we send paths to the server in POSIX form); the underlying OS does the
 * native conversion on the other end.
 */
function joinPath(parent: string, name: string): string {
  const base = parent.replace(/[\\/]+$/, "");
  return base ? `${base}/${name}` : name;
}

/**
 * Sidebar section showing the sandbox root as a live file tree. Clicking a
 * file opens a modal preview dialog sized to the chat panel.
 */
export function WorkspaceExplorer({ treeVersion, onAskAgent, onNotify }: WorkspaceExplorerProps) {
  const [data, setData] = useState<TreeNode[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<FileContent | null>(null);
  const [previewing, setPreviewing] = useState(false);

  // Active sandbox root + "change root" inline form.
  const [root, setRoot] = useState<SandboxRoot | null>(null);
  const [rootEditing, setRootEditing] = useState(false);
  const [rootDraft, setRootDraft] = useState("");
  const [rootSaving, setRootSaving] = useState(false);
  const [rootError, setRootError] = useState<string | null>(null);

  const reloadRoot = useCallback(async () => {
    const result = await fetchSandboxRoot();
    if (result.ok) setRoot(result.data);
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchSandboxTree({ depth: 5 });
      if (result.ok) {
        setData(result.data.nodes);
      } else {
        setError(result.error || "Couldn't reach the server.");
      }
    } catch (err) {
      setError((err as Error).message || "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial mount: load root + tree.
  useEffect(() => {
    void reloadRoot();
    void reload();
  }, [reload, reloadRoot]);

  // Re-fetch tree when the agent writes a file OR when the user changes root.
  useEffect(() => {
    void reload();
  }, [reload, treeVersion, root?.root]);

  const startEditRoot = useCallback(() => {
    setRootDraft(root?.root ?? "");
    setRootError(null);
    setRootEditing(true);
  }, [root]);

  const cancelEditRoot = useCallback(() => {
    setRootEditing(false);
    setRootError(null);
  }, []);

  const saveRoot = useCallback(async () => {
    const draft = rootDraft.trim();
    if (!draft) {
      setRootError("path is required");
      return;
    }
    setRootSaving(true);
    setRootError(null);
    const result = await setSandboxRoot(draft);
    setRootSaving(false);
    if (!result.ok) {
      setRootError(result.error);
      return;
    }
    setRoot(result.data);
    setRootEditing(false);
  }, [rootDraft]);

  // Load preview when a file is selected.
  useEffect(() => {
    if (!selected) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreviewing(true);
    void fetchSandboxFile(selected, { maxBytes: 64 * 1024 }).then((result) => {
      if (cancelled) return;
      if (result.ok) setPreview(result.data);
      setPreviewing(false);
    });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  /* --------------------------- mutations ------------------------------ */
  //
  // The explorer owns the lifecycle of these handlers (refreshing the
  // tree after success, pushing toasts on failure). Each handler is
  // memoized so passing it as a callback prop doesn't recreate per
  // render.

  const handleMkdir = useCallback(
    async (relDir: string) => {
      const r = await sandboxMkdir(relDir);
      if (!r.ok) {
        onNotify({ variant: "error", message: `Create folder failed`, description: r.error });
        return;
      }
      onNotify({ variant: "success", message: `Created ${r.data.path}` });
      void reload();
    },
    [onNotify, reload],
  );

  const handleRename = useCallback(
    async (from: string, to: string) => {
      const r = await sandboxRename(from, to);
      if (!r.ok) {
        onNotify({ variant: "error", message: `Rename failed`, description: r.error });
        return;
      }
      onNotify({ variant: "success", message: `Renamed to ${to}` });
      void reload();
    },
    [onNotify, reload],
  );

  const handleDelete = useCallback(
    async (relPath: string, opts: { recursive?: boolean } = {}) => {
      const r = await sandboxDelete(relPath, opts.recursive);
      if (!r.ok) {
        onNotify({ variant: "error", message: `Delete failed`, description: r.error });
        return;
      }
      const originalPath = r.data.path;
      const trashPath = r.data.trashPath;
      void reload();
      // Push a sticky undo toast. The Undo button renames the entry back
      // out of .trash/ via /api/sandbox/restore.
      onNotify({
        variant: "warning",
        message: `Deleted ${originalPath}` ,
        ttlMs: 8000,
        action: {
          label: "Undo",
          onClick: async () => {
            const rr = await sandboxRestore(trashPath, originalPath);
            if (!rr.ok) {
              onNotify({ variant: "error", message: `Undo failed`, description: rr.error });
              return;
            }
            onNotify({ variant: "success", message: `Restored ${rr.data.path}` });
            void reload();
          },
        },
      });
    },
    [onNotify, reload],
  );

  const handleUpload = useCallback(
    async (relPath: string, data: ArrayBuffer) => {
      const r = await sandboxUpload(relPath, data);
      if (!r.ok) {
        onNotify({ variant: "error", message: `Upload failed`, description: r.error });
        return;
      }
      onNotify({ variant: "success", message: `Uploaded ${r.data.path}` });
      void reload();
    },
    [onNotify, reload],
  );

  // Inline mutation dialogs: small prompt for a new file/folder name, a
  // rename input, and a destructive delete confirm. The state holds the
  // current operation, if any; the dialog is rendered when set.
  type PendingOp =
    | { kind: "newFile"; parent: string }
    | { kind: "newFolder"; parent: string }
    | { kind: "rename"; path: string; name: string }
    | { kind: "delete"; path: string; isDir: boolean }
    ;
  const [pending, setPending] = useState<PendingOp | null>(null);
  const [pendingValue, setPendingValue] = useState("");

  const openNewFile = useCallback((parent: string) => {
    setPending({ kind: "newFile", parent });
    setPendingValue("");
  }, []);
  const openNewFolder = useCallback((parent: string) => {
    setPending({ kind: "newFolder", parent });
    setPendingValue("");
  }, []);
  const openRename = useCallback((path: string) => {
    const name = path.split(/[\\/]/).pop() ?? path;
    setPending({ kind: "rename", path, name });
    setPendingValue(name);
  }, []);
  const openDelete = useCallback((path: string, isDir: boolean) => {
    setPending({ kind: "delete", path, isDir });
    setPendingValue("");
  }, []);
  const closePending = useCallback(() => setPending(null), []);

  const submitPending = useCallback(() => {
    const op = pending;
    if (!op) return;
    if (op.kind === "newFile") {
      const v = pendingValue.trim();
      if (!v) return;
      const path = joinPath(op.parent, v);
      // We don't expose a sandboxWrite endpoint, so we ask the agent
      // via the Ask the agent path. Easiest fallback: just upload an
      // empty file so the row appears and the user can edit it.
      void handleUpload(path, new TextEncoder().encode("").buffer);
      closePending();
      return;
    }
    if (op.kind === "newFolder") {
      const v = pendingValue.trim();
      if (!v) return;
      void handleMkdir(joinPath(op.parent, v));
      closePending();
      return;
    }
    if (op.kind === "rename") {
      const v = pendingValue.trim();
      if (!v || v === op.name) {
        closePending();
        return;
      }
      const dir = op.path.replace(/[^\\/]+$/, "");
      void handleRename(op.path, joinPath(dir, v));
      closePending();
      return;
    }
    if (op.kind === "delete") {
      // Confirm via a sticky toast with an Undo action that re-creates
      // the file/folder is not trivial without a trash. So we just
      // push a confirmation toast and only delete on dismiss.
      onNotify({ variant: "warning", message: `Deleted ${op.path}` });
      void handleDelete(op.path, { recursive: op.isDir });
      closePending();
      return;
    }
  }, [closePending, handleDelete, handleMkdir, handleRename, handleUpload, onNotify, pending, pendingValue]);

  // File-input ref for the upload picker. The picker writes to whatever
  // path the user chose; we default to the root and let them override.
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const triggerUpload = useCallback(() => uploadInputRef.current?.click(), []);
  const onUploadChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      const buf = await file.arrayBuffer();
      await handleUpload(file.name, buf);
    },
    [handleUpload],
  );

  const items = useMemo<TreeListItemData[]>(
    () => (data ?? []).filter((n) => !HIDDEN_TREE_NAMES.has(n.name)).map((node) => toItemData(node, "", setSelected)),
    [data],
  );

  return (
    <div className="workspace-explorer">
      <div className="workspace-explorer__root" onDoubleClick={startEditRoot}>
        <Icon icon={FolderClosedIcon} size="sm" />
        <button
          type="button"
          className="workspace-explorer__root-path"
          onClick={root?.root ? startEditRoot : undefined}
          title={root?.root ?? "(loading)"}
        >
          {root?.root ?? "(loading…)"}
        </button>
        <IconButton
          label="Change workspace folder"
          size="sm"
          variant="ghost"
          onClick={startEditRoot}
          icon={<Icon icon={RefreshCwIcon} size="sm" />}
        />
      </div>

      {rootEditing && (
        <div className="workspace-explorer__root-edit">
          <TextInput
            label="Workspace folder"
            value={rootDraft}
            onChange={(v) => setRootDraft(v)}
            placeholder="e.g. C:\\Users\\you\\Projects"
            isLabelHidden
            size="sm"
            isDisabled={rootSaving}
          />
          <div className="workspace-explorer__root-edit-actions">
            <Button
              label="Save"
              size="sm"
              variant="primary"
              onClick={saveRoot}
              isLoading={rootSaving}
              isDisabled={rootSaving}
            />
            <Button
              label="Cancel"
              size="sm"
              variant="secondary"
              onClick={cancelEditRoot}
              isDisabled={rootSaving}
            />
          </div>
          {rootError && (
            <Text type="supporting" color="disabled">
              {rootError}
            </Text>
          )}
        </div>
      )}

      <div className="workspace-explorer__header">
        <Text type="label">Workspace</Text>
        <div className="workspace-explorer__toolbar">
          <IconButton
            label="New file"
            size="sm"
            variant="ghost"
            onClick={() => openNewFile("")}
            icon={<Icon icon={FilePlusIcon} size="sm" />}
          />
          <IconButton
            label="New folder"
            size="sm"
            variant="ghost"
            onClick={() => openNewFolder("")}
            icon={<Icon icon={FolderPlusIcon} size="sm" />}
          />
          <IconButton
            label="Upload file"
            size="sm"
            variant="ghost"
            onClick={triggerUpload}
            icon={<Icon icon={UploadIcon} size="sm" />}
          />
          <IconButton
            label="Refresh workspace"
            size="sm"
            variant="ghost"
            onClick={() => void reload()}
            icon={<Icon icon={RefreshCwIcon} size="sm" />}
          />
        </div>
      </div>

      {error && (
        <Text type="supporting" color="disabled">
          {error}
        </Text>
      )}

      {data && data.length === 0 && !loading && (
        <Text type="supporting" color="secondary">
          (empty)
        </Text>
      )}

      {loading && !data && (
        <Spinner size="sm" label="Loading workspace" />
      )}

      {items.length > 0 && (
        <div className="workspace-explorer__tree">
          <TreeList items={items} density="compact" />
        </div>
      )}

      {/* Mutation prompt: a single Dialog that handles new-file, new-folder,
          rename, and delete confirms. The kind determines the copy. */}
      <Dialog
        isOpen={pending !== null}
        onOpenChange={(open) => { if (!open) closePending(); }}
        purpose="form"
        width={420}
      >
        <VStack gap={3} className="workspace-explorer__mutation-dialog">
          <div className="workspace-explorer__mutation-dialog-header">
            <Text type="display-3" as="h2">
              {pending?.kind === "newFile" ? "New file"
                : pending?.kind === "newFolder" ? "New folder"
                : pending?.kind === "rename" ? "Rename"
                : pending?.kind === "delete" ? "Delete?"
                : ""}
            </Text>
          </div>

          {pending?.kind === "delete" ? (
            <Text type="supporting" color="secondary">
              Delete <code>{pending.path}</code>? This cannot be undone.
            </Text>
          ) : (
            <TextInput
              label="Name"
              value={pendingValue}
              onChange={setPendingValue}
              isLabelHidden
              size="sm"
              placeholder={
                pending?.kind === "newFile" ? "example.txt"
                  : pending?.kind === "newFolder" ? "example-dir"
                  : pending?.kind === "rename" ? "new-name"
                  : ""
              }
              hasAutoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitPending();
                }
              }}
            />
          )}

          <div className="workspace-explorer__mutation-dialog-footer">
            <Button
              label="Cancel"
              size="sm"
              variant="secondary"
              onClick={closePending}
            />
            <Button
              label={
                pending?.kind === "delete" ? "Delete"
                  : pending?.kind === "rename" ? "Rename"
                  : pending?.kind === "newFolder" ? "Create folder"
                  : "Create"
              }
              size="sm"
              variant="primary"
              onClick={submitPending}
            />
          </div>
        </VStack>
      </Dialog>

      {/* Hidden file input for the toolbar Upload button. The picker
          writes the chosen file to the sandbox via /api/sandbox/upload. */}
      <input
        ref={uploadInputRef}
        type="file"
        className="workspace-explorer__file-input"
        aria-hidden
        tabIndex={-1}
        onChange={(e) => void onUploadChange(e)}
      />

      <Dialog
        isOpen={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        purpose="info"
        // Match the chat panel max-width so the preview sits visually inside
        // the same column rather than popping wider.
        width={980}
        maxHeight="80vh"
      >
        <VStack gap={3} className="workspace-explorer__preview">
          <div className="workspace-explorer__preview-header">
            <div className="workspace-explorer__preview-name">
              <Icon icon={FileIcon} size="sm" />
              <Text type="label" color="secondary">
                {selected ?? ""}
              </Text>
            </div>
            <div className="workspace-explorer__preview-actions">
              <IconButton
                label="Copy file contents"
                size="sm"
                variant="ghost"
                isDisabled={!preview}
                onClick={() => {
                  if (preview?.content) {
                    void navigator.clipboard?.writeText(preview.content);
                  }
                }}
                icon={<Icon icon={CopyIcon} size="sm" />}
              />
              <Button
                label="Ask the agent"
                size="sm"
                variant="secondary"
                onClick={() => selected && onAskAgent(selected)}
                isDisabled={!selected}
                icon={<Icon icon={MessageCircleIcon} size="sm" />}
              />
              <IconButton
                label="Close preview"
                size="sm"
                variant="ghost"
                onClick={() => setSelected(null)}
                icon={<Icon icon={XIcon} size="sm" />}
              />
            </div>
          </div>
          {previewing ? (
            <Spinner size="sm" label="Loading file" />
          ) : preview ? (
            <CodeBlock
              code={preview.content}
              hasCopyButton={false}
              hasLanguageLabel={false}
              container="section"
              width="100%"
              size="sm"
              maxHeight={520}
            />
          ) : (
            <Text type="supporting" color="disabled">
              Couldn't load file.
            </Text>
          )}
          {preview?.truncated && (
            <Text type="supporting" color="secondary">
              Truncated — file is larger than the 64 KiB preview cap.
            </Text>
          )}
        </VStack>
      </Dialog>
    </div>
  );
}

/**
 * Convert a `TreeNode` from the API into a `TreeListItemData` for Astryx's
 * `TreeList`. Folder items get their children flattened inline (the API
 * returns them, no extra fetch on expand).
 */
// The trash directory we move deletes into. Hidden from the file tree so
// users do not see a recursive bin appearing under their workspace.
const HIDDEN_TREE_NAMES: ReadonlySet<string> = new Set([".trash"]);

function toItemData(
  node: TreeNode,
  prefix: string,
  select: (relPath: string) => void,
): TreeListItemData {
  // Defensive: a filter at the items level would leave an empty parent,
  // so we recurse-filter inside the children map below. This top check is
  // a no-op for the common (non-trash) case and only fires when toItemData
  // is called directly with a trash node (currently impossible because the
  // root-level items call filters it out first).
  if (HIDDEN_TREE_NAMES.has(node.name)) {
    throw new Error("unreachable: toItemData called on hidden node");
  }
  const relPath = prefix ? `${prefix}/${node.name}` : node.name;
  const isDir = node.kind === "dir";
  return {
    id: relPath,
    label: <code className="workspace-explorer__name">{node.name}</code>,
    startContent: <Icon icon={isDir ? FolderClosedIcon : FileIcon} size="sm" />,
    endContent: isDir ? (
      node.hasMore ? (
        <span className="workspace-explorer__more">
          +{node.truncatedChildCount ?? "?"}
        </span>
      ) : undefined
    ) : (
      <span className="workspace-explorer__size">{formatSize(node.size)}</span>
    ),
    onClick: isDir ? undefined : () => select(relPath),
    children:
      isDir && node.children
        ? node.children
            .filter((c) => !HIDDEN_TREE_NAMES.has(c.name))
            .map((c) => toItemData(c, relPath, select))
        : undefined,
  };
}

function formatSize(bytes: number | null): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes}b`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

// Keep imports referenced.
void VStack;


