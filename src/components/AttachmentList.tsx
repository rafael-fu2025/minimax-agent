// filepath: src/components/AttachmentList.tsx
import { useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { FileIcon, FileTextIcon, ImageIcon, VideoIcon, XIcon } from "lucide-react";
import type { AttachmentMeta, ContentPart } from "../types";

/* -------------------------------------------------------------------------- */
/* File-type helpers                                                           */
/* -------------------------------------------------------------------------- */

const IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const VIDEO_MIMES = new Set([
  "video/mp4",
  "video/avi",
  "video/quicktime",
  "video/x-matroska",
  "video/x-msvideo",
]);
const PDF_MIMES = new Set(["application/pdf"]);

export function kindOf(mime: string): AttachmentMeta["kind"] {
  if (IMAGE_MIMES.has(mime)) return "image";
  if (VIDEO_MIMES.has(mime)) return "video";
  if (PDF_MIMES.has(mime)) return "pdf";
  return "other";
}

export function iconFor(kind: AttachmentMeta["kind"]) {
  switch (kind) {
    case "image":
      return ImageIcon;
    case "video":
      return VideoIcon;
    case "pdf":
      return FileTextIcon;
    default:
      return FileIcon;
  }
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/* -------------------------------------------------------------------------- */
/* Inline image thumbnail cache                                                 */
/*                                                                            */
/* We resolve `File` -> data URL for images so the chip strip can show a       */
/* preview without the parent having to plumb object URLs around. LRU-bounded  */
/* so very long-lived composers don't grow unboundedly.                        */
/* -------------------------------------------------------------------------- */

const thumbCache = new Map<string, string>();
const THUMB_CACHE_MAX = 50;

function readImageDataUrl(file: File): Promise<string> {
  const key = `${file.name}:${file.size}:${file.lastModified}`;
  const hit = thumbCache.get(key);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      if (url) {
        if (thumbCache.size >= THUMB_CACHE_MAX) {
          // Drop the oldest entry (Map preserves insertion order).
          const first = thumbCache.keys().next().value;
          if (first !== undefined) thumbCache.delete(first);
        }
        thumbCache.set(key, url);
      }
      resolve(url);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Read a `File` as a base64 data URL without caching. Used at send time
 * for inline images / small videos — we don't want to keep the resulting
 * multi-MB string in the LRU thumbnail cache.
 */
export function readFileAsDataUrl(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

export interface AttachmentListProps {
  attachments: AttachmentMeta[];
  onRemove: (id: string) => void;
  /** Optional error for a specific attachment (e.g. "too large"). */
  errors?: Record<string, string>;
}

/**
 * Strip of attachment chips rendered above the ChatComposer. Each chip
 * shows a thumbnail (images) or a kind icon, the file name, a human-readable
 * size, and a remove button.
 */
export function AttachmentList({
  attachments,
  onRemove,
  errors,
}: AttachmentListProps) {
  if (attachments.length === 0) return null;

  return (
    <div className="attachment-list" role="list" aria-label="Attachments">
      {attachments.map((a) => (
        <AttachmentChip
          key={a.id}
          attachment={a}
          error={errors?.[a.id]}
          onRemove={() => onRemove(a.id)}
        />
      ))}
    </div>
  );
}

function AttachmentChip({
  attachment,
  error,
  onRemove,
}: {
  attachment: AttachmentMeta;
  error?: string;
  onRemove: () => void;
}) {
  const [thumb, setThumb] = useState<string | null>(null);
  const thumbRef = useRef<string | null>(null);

  useEffect(() => {
    if (attachment.kind !== "image") return;
    let cancelled = false;
    // We only have the `File` momentarily via a side channel — for the
    // chip display we accept that the parent's `previewUrl` (an object URL)
    // is the cheap path. If the parent didn't pass one, fall back to a
    // generic icon.
    if (attachment.previewUrl) {
      thumbRef.current = attachment.previewUrl;
      setThumb(attachment.previewUrl);
      return;
    }
    return () => {
      cancelled = true;
    };
  }, [attachment]);

  const IconCmp = iconFor(attachment.kind);
  return (
    <div
      role="listitem"
      className={`attachment-chip${error ? " is-error" : ""}`}
      title={attachment.name}
    >
      <div className="attachment-chip__media">
        {thumb && attachment.kind === "image" ? (
          <img src={thumb} alt="" className="attachment-chip__thumb" />
        ) : (
          <Icon icon={IconCmp} size="sm" />
        )}
      </div>
      <div className="attachment-chip__text">
        <Text type="label" className="attachment-chip__name">
          {attachment.name}
        </Text>
        <Text type="supporting" color={error ? "accent" : "secondary"}>
          {error ? error : humanSize(attachment.size)}
        </Text>
      </div>
      <Button
        label="Remove"
        size="sm"
        variant="ghost"
        aria-label={`Remove ${attachment.name}`}
        onClick={onRemove}
        icon={<Icon icon={XIcon} size="sm" />}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

/** MiniMax M3 limits surfaced for client-side validation. */
export const M3_LIMITS = {
  imageMaxBytes: 10 * 1024 * 1024, // 10 MB
  videoBase64MaxBytes: 50 * 1024 * 1024, // 50 MB (base64 in request)
  videoUploadedMaxBytes: 512 * 1024 * 1024, // 512 MB (Files API)
  requestBodyMaxBytes: 64 * 1024 * 1024, // 64 MB
  supportedImageMimes: IMAGE_MIMES,
  supportedVideoMimes: VIDEO_MIMES,
};

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

export function validateAttachment(file: File): ValidationResult {
  const kind = kindOf(file.type);
  if (kind === "other") {
    if (PDF_MIMES.has(file.type)) {
      // PDFs are accepted but converted to images before being sent.
      return { ok: true };
    }
    return {
      ok: false,
      error: `Unsupported file type (${file.type || "unknown"}). Try image, video, or PDF.`,
    };
  }
  if (kind === "image" && file.size > M3_LIMITS.imageMaxBytes) {
    return {
      ok: false,
      error: `Image is ${humanSize(file.size)} (max 10 MB).`,
    };
  }
  if (kind === "video" && file.size > M3_LIMITS.videoBase64MaxBytes) {
    // >50 MB videos must be uploaded via the Files API proxy. We allow
    // them through and let the upload helper route appropriately.
    return { ok: true };
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* File -> ContentPart                                                         */
/* -------------------------------------------------------------------------- */

/** Convert a `File` to an OpenAI-compatible `ContentPart` for inlining. */
export async function fileToContentPart(
  file: File,
): Promise<ContentPart> {
  const kind = kindOf(file.type);
  if (kind === "image") {
    const url = await readImageDataUrl(file);
    return {
      type: "image_url",
      image_url: { url, detail: "default" },
    };
  }
  if (kind === "video") {
    const url = await readImageDataUrl(file);
    return {
      type: "video_url",
      video_url: { url, fps: 1 },
    };
  }
  // Other kinds (incl. PDF) shouldn't reach here in the inline path; the
  // composer routes PDFs through a separate image-rendering flow.
  throw new Error(`Cannot inline file of type ${file.type}`);
}

