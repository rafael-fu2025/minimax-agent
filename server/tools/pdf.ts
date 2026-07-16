/**
 * `pdf_read` — extract text from a PDF in the sandbox using `pdf-parse`.
 * Hard caps: 1000 pages or 50 MiB. Read-only — no approval in any mode.
 */

import { stat, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolveSafePath } from "./sandbox.js";
import type { ToolDefinition } from "../tools.js";

// pdf-parse is CJS; the .d.ts in src/types/ provides the type.
const requireCJS = createRequire(import.meta.url);
const pdfParse = requireCJS("pdf-parse") as (
  buffer: Buffer,
  opts?: { max?: number },
) => Promise<{ numpages: number; info: Record<string, unknown>; text: string }>;

const MAX_PAGES = 1000;
const MAX_BYTES = 50 * 1024 * 1024;

const pdfReadTool: ToolDefinition = {
  name: "pdf_read",
  description:
    "Read text from a PDF in the sandbox. Returns the first `max_pages` (default 50, cap 1000) of the document as plain text. File size capped at 50 MiB. Read-only — no approval in any mode.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "PDF path, relative to the sandbox root." },
      max_pages: {
        type: "number",
        description: "Max pages to read. Default 50, cap 1000.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  preview: (args) =>
    `pdf ${typeof args.path === "string" ? args.path : "?"}`,
  execute: async (args) => {
    try {
      const target = await resolveSafePath(String(args.path ?? ""));
      const s = await stat(target);
      if (!s.isFile()) return `Error: not a file: ${args.path}`;
      if (s.size > MAX_BYTES) return `Error: file too large (${s.size} bytes; cap 50 MiB)`;
      const buf = await readFile(target);
      const result = await pdfParse(buf, {
        max: MAX_PAGES,
        // Don't render the entire thing if it's huge.
        // pdf-parse caps at `max` pages by default.
      });
      return JSON.stringify(
        {
          path: args.path,
          numpages: result.numpages,
          info: result.info ?? {},
          text: result.text,
          truncated: result.numpages >= MAX_PAGES,
        },
        null,
        2,
      );
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const pdfTools: ToolDefinition[] = [pdfReadTool];
