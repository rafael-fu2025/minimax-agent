/**
 * `archive_zip` / `archive_unzip` — zip a directory or extract a zip into
 * the sandbox. Both route their destination through `resolveSafePath`.
 *
 * Hard caps: 10 000 entries and 500 MiB cumulative; if either is exceeded
 * the operation aborts with a friendly error rather than OOMing the
 * server. Read-only / mutating tools follow the standard approval rules.
 */

import { createWriteStream, createReadStream } from "node:fs";
import { stat, mkdir } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createRequire } from "node:module";
import { resolveSafePath, getSandboxRoot } from "./sandbox.js";
import { relative } from "node:path";
import type { ToolDefinition } from "../tools.js";

// `archiver` and `unzipper` are CJS modules with no default ESM export.
// Use `createRequire` so we get the CJS namespace and call its factory
// function directly. The .d.ts in src/types/ provides the types.
const requireCJS = createRequire(import.meta.url);
const archiver = requireCJS("archiver") as (
  format?: "zip",
  options?: { zlib?: { level?: number } },
) => NodeJS.ReadWriteStream & {
  on(event: "error" | "warning", listener: (err: Error) => void): unknown;
  directory(path: string, dest?: string): unknown;
  finalize(): Promise<unknown>;
  pipe<T>(dest: T): T;
};
import unzipper from "unzipper";

const MAX_ENTRIES = 10_000;
const MAX_BYTES = 500 * 1024 * 1024;

async function countAndSize(absDir: string): Promise<{ entries: number; bytes: number }> {
  // Cheap pre-flight; exact counts require a full walk, this is a safety
  // net so a 10M-entry directory doesn't OOM the process before we can
  // abort.
  const s = await stat(absDir);
  if (s.isFile()) {
    return { entries: 1, bytes: s.size };
  }
  let entries = 1;
  let bytes = 0;
  // Hard-stop at the cap.
  const stack: string[] = [absDir];
  while (stack.length > 0 && entries < MAX_ENTRIES && bytes < MAX_BYTES) {
    const cur = stack.pop()!;
    const { readdir } = await import("node:fs/promises");
    const ents = await readdir(cur, { withFileTypes: true });
    for (const e of ents) {
      const abs = `${cur}/${e.name}`;
      if (e.isDirectory()) {
        entries++;
        stack.push(abs);
      } else {
        entries++;
        try {
          const fs2 = await stat(abs);
          bytes += fs2.size;
        } catch {
          // ignore
        }
        if (bytes > MAX_BYTES) break;
      }
      if (entries > MAX_ENTRIES) break;
    }
  }
  return { entries, bytes };
}

const archiveZipTool: ToolDefinition = {
  name: "archive_zip",
  description:
    "Zip a directory (or file) into a .zip file inside the sandbox. `src_dir` is the folder to zip (its contents are added recursively). `dest_path` is the output .zip path. Hard caps: 10 000 entries / 500 MiB. Mutating — prompts in `safe`, auto-approved in `accept-edits` and `bypass`.",
  parameters: {
    type: "object",
    properties: {
      src_dir: { type: "string", description: "Source directory (or file) to zip, relative to the sandbox root." },
      dest_path: { type: "string", description: "Output .zip path, relative to the sandbox root." },
    },
    required: ["src_dir", "dest_path"],
    additionalProperties: false,
  },
  preview: (args) =>
    `zip ${typeof args.src_dir === "string" ? args.src_dir : "?"} → ${
      typeof args.dest_path === "string" ? args.dest_path : "?"
    }`,
  execute: async (args) => {
    try {
      const src = await resolveSafePath(String(args.src_dir ?? ""));
      const dest = await resolveSafePath(String(args.dest_path ?? ""));
      const { entries, bytes } = await countAndSize(src);
      if (entries > MAX_ENTRIES) return `Error: source has ${entries} entries (cap ${MAX_ENTRIES})`;
      if (bytes > MAX_BYTES) return `Error: source is ${(bytes / 1_048_576).toFixed(1)} MiB (cap 500 MiB)`;
      // Ensure the parent dir of dest exists.
      await mkdir(`${dest.replace(/[\\/][^\\/]+$/, "")}`, { recursive: true }).catch(() => {});
      await new Promise<void>((resolve, reject) => {
        const out = createWriteStream(dest);
        const archive = archiver("zip", { zlib: { level: 9 } });
        out.on("close", () => resolve());
        out.on("error", reject);
        archive.on("error", (err: Error) => reject(err));
        archive.on("warning", (err: Error) => {
          if ((err as { code?: string }).code !== "ENOENT") reject(err);
        });
        archive.pipe(out);
        const base = getSandboxRoot();
        archive.directory(src, relative(base, src) || ".");
        archive.finalize();
      });
      return `Wrote ${entries} entries to ${args.dest_path}`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

const archiveUnzipTool: ToolDefinition = {
  name: "archive_unzip",
  description:
    "Extract a .zip file into a directory in the sandbox. `src_path` is the .zip file. `dest_dir` is the target directory (created if missing). Refuses to extract any entry that would escape the target directory (zip-slip guard). Hard caps: 10 000 entries / 500 MiB. Mutating — prompts in `safe`, auto-approved in `accept-edits` and `bypass`.",
  parameters: {
    type: "object",
    properties: {
      src_path: { type: "string", description: "Source .zip path, relative to the sandbox root." },
      dest_dir: { type: "string", description: "Destination directory, relative to the sandbox root. Created if missing." },
    },
    required: ["src_path", "dest_dir"],
    additionalProperties: false,
  },
  preview: (args) =>
    `unzip ${typeof args.src_path === "string" ? args.src_path : "?"} → ${
      typeof args.dest_dir === "string" ? args.dest_dir : "?"
    }`,
  execute: async (args) => {
    try {
      const src = await resolveSafePath(String(args.src_path ?? ""));
      const dest = await resolveSafePath(String(args.dest_dir ?? ""));
      await mkdir(dest, { recursive: true });
      let entries = 0;
      let bytes = 0;
      // zip-slip guard: every extracted entry's resolved path must stay
      // inside `dest` after path normalization.
      const { realpath } = await import("node:fs/promises");
      const destReal = await realpath(dest).catch(() => dest);
      const path = await import("node:path");
      // Use unzipper's direct async iterator — simpler than pipeline,
      // which fights unzipper's ReadWriteStream contract.
      const parser = unzipper.Parse();
      createReadStream(src).pipe(parser as unknown as NodeJS.WritableStream);
      for await (const entry of parser as unknown as AsyncIterable<{
        path: string;
        type: string;
        vars?: { size?: number; uncompressedSize?: number; [k: string]: unknown };
        autodrain: () => void;
      }>) {
        entries++;
        if (entries > MAX_ENTRIES) {
          entry.autodrain();
          throw new Error("too many entries (cap " + MAX_ENTRIES + ")");
        }
        if (entry.type === "Directory") continue;
        const abs = path.join(dest, entry.path);
        const rel = path.relative(destReal, abs);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          entry.autodrain();
          throw new Error("zip-slip blocked: " + entry.path);
        }
        bytes += entry.vars?.uncompressedSize ?? entry.vars?.size ?? 0;
        if (bytes > MAX_BYTES) {
          entry.autodrain();
          throw new Error("extracted size exceeds cap (500 MiB)");
        }
        await pipeline(
          entry as unknown as NodeJS.ReadableStream,
          createWriteStream(abs) as unknown as NodeJS.WritableStream,
        );
      }
      return `Extracted ${entries} entries to ${args.dest_dir}`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const archiveTools: ToolDefinition[] = [archiveZipTool, archiveUnzipTool];
