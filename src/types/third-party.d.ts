declare module "archiver" {
  import type { Readable, Writable } from "node:stream";
  type ArchiverOptions = {
    zlib?: { level?: number };
    [k: string]: unknown;
  };
  type EntryData = { name?: string; prefix?: string };
  class Archiver extends Readable {
    constructor(format?: "zip", options?: ArchiverOptions);
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "warning", listener: (err: Error) => void): this;
    on(event: "close" | "end", listener: () => void): this;
    pipe<T>(dest: T, opts?: { end?: boolean }): T;
    append(source: Buffer | string | NodeJS.ReadableStream, destPath?: string | EntryData): this;
    file(name: string, source: Buffer | NodeJS.ReadableStream): this;
    directory(dirPath: string, destPath?: string, entryData?: EntryData): this;
    glob(pattern: string, options?: object, data?: EntryData): this;
    finalize(): Promise<Archiver>;
    abort(): this;
    setFormat(format: string): this;
  }
  // CJS module — `require('archiver')` returns the factory function.
  function createArchiver(format?: "zip", options?: ArchiverOptions): Archiver;
  namespace createArchiver {
    type Options = ArchiverOptions;
  }
  export = createArchiver;
}

declare module "unzipper" {
  import type { Readable } from "node:stream";
  interface ParseOptions {
    forceStream?: boolean;
    [k: string]: unknown;
  }
  interface ParsedEntry extends Readable {
    path: string;
    type: "File" | "Directory" | "SymbolicLink";
    vars?: { uncompressedSize?: number; size?: number; [k: string]: unknown };
    autodrain(): void;
  }
  class Parser extends Readable {
    constructor(opts?: ParseOptions);
    on(event: "entry", listener: (entry: ParsedEntry) => void): this;
    on(event: "close", listener: () => void): this;
    on(event: "error", listener: (err: Error) => void): this;
  }
  function Parse(opts?: ParseOptions): Parser;
  export { Parse };
}

/* -------------------------------------------------------------------------- */
/* pdfjs-dist (client-side PDF rasterization)                                  */
/* -------------------------------------------------------------------------- */

declare module "pdfjs-dist" {
  /** Minimal subset of the pdfjs-dist public API we use. */
  export interface PDFDocumentProxy {
    readonly numPages: number;
    getPage(pageNumber: number): Promise<PDFPageProxy>;
    cleanup(): Promise<void>;
    destroy(): void;
  }
  export interface PDFPageProxy {
    getViewport(opts: { scale: number }): { width: number; height: number };
    render(opts: {
      canvasContext?: CanvasRenderingContext2D;
      viewport: { width: number; height: number };
      canvas?: HTMLCanvasElement;
      // pdfjs accepts many more; we type what we use.
    }): { promise: Promise<void> };
    cleanup(): void;
  }
  export interface PDFDocumentLoadingTask {
    promise: Promise<PDFDocumentProxy>;
  }
  export const GlobalWorkerOptions: { workerSrc: string };
  export function getDocument(opts: {
    data: Uint8Array | ArrayBuffer;
    disableAutoFetch?: boolean;
    disableStream?: boolean;
    [k: string]: unknown;
  }): PDFDocumentLoadingTask;
}

/* Vite `?url` query — returns a string URL for the asset. */
declare module "*?url" {
  const url: string;
  export default url;
}
