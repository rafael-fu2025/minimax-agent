/**
 * `image_generate` — POST a prompt to the MiniMax image API and save the
 * returned image (PNG) into the sandbox. Reuses the existing MiniMax key
 * and base URL.
 *
 *   MINIMAX_API_KEY      (required for actual use)
 *   MINIMAX_BASE_URL      (default https://api.minimax.io/v1)
 *   IMAGE_GEN_MODEL       (default "minimax-image-01")
 *   IMAGE_GEN_OUTPUT_DIR  (default "images" inside the sandbox)
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getSandboxRoot, resolveSafePath } from "./sandbox.js";
import type { ToolDefinition } from "../tools.js";
import { getRotator } from "../keys/rotator.js";

const DEFAULT_MODEL = "minimax-image-01";

const imageGenerateTool: ToolDefinition = {
  name: "image_generate",
  description:
    "Generate an image from a text prompt via MiniMax's image API. Saves the resulting PNG (or first returned image) into the sandbox at `images/<safe-filename>.png` (under the `IMAGE_GEN_OUTPUT_DIR`, default `images/`). Returns the relative path of the saved file plus the model name. Mutating — high-risk: prompts in BOTH `safe` AND `accept-edits` (the model call can leak the prompt to a third party).",
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Text prompt describing the desired image." },
      size: { type: "string", description: "Optional size like '1024x1024'. Falls back to model default." },
      n: { type: "number", description: "Number of images to generate. Default 1." },
      filename: {
        type: "string",
        description: "Optional override for the output filename (no extension; .png is appended).",
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
  preview: (args) => {
    const p = typeof args.prompt === "string" ? args.prompt.slice(0, 60) : "?";
    const ellipsis =
      typeof args.prompt === "string" && args.prompt.length > 60 ? "..." : "";
    return `image "${p}${ellipsis}"`;
  },
  execute: async (args) => {
    try {
      const prompt = String(args.prompt ?? "").trim();
      if (!prompt) return "Error: prompt is required";
      // Route through the key rotator so the image tool benefits from
      // multi-key rotation (DB-stored keys + env-var bootstrap) and the
      // same 429/5xx backoff the chat uses. Falls through to a clear
      // error when no keys are configured at all.
      const baseUrl = (process.env.MINIMAX_BASE_URL ?? "https://api.minimax.io/v1").replace(/\/+$/, "");
      const model = process.env.IMAGE_GEN_MODEL ?? DEFAULT_MODEL;
      const url = `${baseUrl}/images/generations`;
      const body: Record<string, unknown> = {
        model,
        prompt,
        response_format: "url",
        n: Math.min(Math.max(Number(args.n ?? 1), 1), 4),
      };
      if (args.size) body.size = String(args.size);
      const rotator = await getRotator(baseUrl);
      const res = await rotator.call(async (secret) =>
        fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${secret}`,
          },
          body: JSON.stringify(body),
        }),
      );
      const txt = await res.text();
      if (!res.ok) return `Error: image API ${res.status}: ${txt.slice(0, 400)}`;
      const j = JSON.parse(txt) as { data?: Array<{ url?: string; b64_json?: string }> };
      const item = j.data?.[0];
      if (!item) return `Error: no image in response: ${txt.slice(0, 200)}`;
      const sandboxRoot = getSandboxRoot();
      const outDirRel = process.env.IMAGE_GEN_OUTPUT_DIR ?? "images";
      const outDirAbs = await resolveSafePath(outDirRel);
      await mkdir(outDirAbs, { recursive: true });
      const baseName = (args.filename && String(args.filename)) || prompt
        .slice(0, 40)
        .replace(/[^A-Za-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .toLowerCase() || "image";
      const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
      const outName = `${baseName}_${stamp}.png`;
      const outAbs = join(outDirAbs, outName);
      const outRel = join(outDirRel, outName);
      let bytes: number;
      if (item.url) {
        const r2 = await fetch(item.url);
        if (!r2.ok) return `Error: failed to fetch image from ${item.url}: ${r2.status}`;
        const buf = Buffer.from(await r2.arrayBuffer());
        bytes = buf.byteLength;
        await writeFile(outAbs, buf);
      } else if (item.b64_json) {
        const buf = Buffer.from(item.b64_json, "base64");
        bytes = buf.byteLength;
        await writeFile(outAbs, buf);
      } else {
        return "Error: response had no url or b64_json";
      }
      return JSON.stringify(
        {
          path: outRel.replace(/\\/g, "/"),
          bytes,
          model,
        },
        null,
        2,
      );
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const imageTools: ToolDefinition[] = [imageGenerateTool];


