// filepath: src/components/pdfRasterize.ts
//
// Rasterize the first N pages of a PDF into PNG data URLs, suitable for
// sending as `image_url` content parts to MiniMax M3 (which doesn't accept
// PDFs natively, so we render each page and ship the image instead).
//
// Uses `pdfjs-dist@5` ESM. The worker is configured to the bundled
// `pdf.worker.mjs` shipped with the package so the browser doesn't try to
// fetch it from a CDN.
import * as pdfjs from "pdfjs-dist";
// Vite resolves this to a hashed URL that pdfjs can pass to
// `GlobalWorkerOptions.workerSrc`. The `?url` suffix is a Vite-specific way
// to get a public URL for the file.
import PdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

export interface RasterizedPage {
  pageNumber: number;
  dataUrl: string;
  /** Pixel dimensions of the rendered page. */
  width: number;
  height: number;
}

const DEFAULT_MAX_PAGES = 4;
const DEFAULT_RENDER_SCALE = 1.5;

let workerConfigured = false;

function ensureWorker(): void {
  if (workerConfigured) return;
  pdfjs.GlobalWorkerOptions.workerSrc = PdfWorkerUrl;
  workerConfigured = true;
}

/**
 * Render up to `maxPages` of `file` to PNG data URLs.
 * Each page is rendered at `scale * 96 DPI` (so scale 1 = 96 DPI, 1.5 = 144 DPI).
 *
 * Throws if the file isn't a valid PDF.
 */
export async function rasterizePdf(
  file: File | Blob,
  opts: { maxPages?: number; scale?: number; signal?: AbortSignal } = {},
): Promise<RasterizedPage[]> {
  ensureWorker();
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? DEFAULT_MAX_PAGES, 16));
  const scale = opts.scale ?? DEFAULT_RENDER_SCALE;

  const buf = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjs.getDocument({
    data: buf,
    // `useWorkerFetch: false` keeps pdfjs from trying to fetch the worker
    // again on each page; we already configured the worker globally.
    disableAutoFetch: true,
    disableStream: true,
  });

  const doc = await loadingTask.promise;
  try {
    const pageCount = Math.min(doc.numPages, maxPages);
    const pages: RasterizedPage[] = [];
    for (let i = 1; i <= pageCount; i++) {
      if (opts.signal?.aborted) break;
      const page = await doc.getPage(i);
      try {
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          throw new Error("Could not create 2D canvas context for PDF page");
        }
        await page.render({
          canvasContext: ctx,
          viewport,
          canvas,
        }).promise;
        const dataUrl = canvas.toDataURL("image/png");
        pages.push({
          pageNumber: i,
          dataUrl,
          width: canvas.width,
          height: canvas.height,
        });
      } finally {
        page.cleanup();
      }
    }
    return pages;
  } finally {
    await doc.cleanup();
    doc.destroy();
  }
}

/**
 * Best-effort: try to read the page count without rendering anything.
 * Falls back to 0 if the document can't be opened.
 */
export async function pdfPageCount(file: File | Blob): Promise<number> {
  ensureWorker();
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const doc = await pdfjs.getDocument({ data: buf }).promise;
    const n = doc.numPages;
    await doc.cleanup();
    doc.destroy();
    return n;
  } catch {
    return 0;
  }
}
