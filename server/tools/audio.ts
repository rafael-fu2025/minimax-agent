/**
 * `transcribe_audio` — POST an audio file in the sandbox to an
 * OpenAI-compatible Whisper endpoint. Requires `OPENAI_AUDIO_URL` env var
 * (defaults to the official OpenAI audio-transcriptions endpoint). Read-only
 * in spirit (it doesn't modify the workspace) but classified as mutating
 * for the approval flow because audio uploads can leak data to a third
 * party.
 *
 *   OPENAI_AUDIO_URL = https://api.openai.com/v1/audio/transcriptions
 *   OPENAI_AUDIO_KEY = sk-...   (falls back to MINIMAX_API_KEY)
 *   OPENAI_AUDIO_MODEL = whisper-1   (default)
 */

import { stat, readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { resolveSafePath } from "./sandbox.js";
import type { ToolDefinition } from "../tools.js";

const DEFAULT_URL = "https://api.openai.com/v1/audio/transcriptions";
const DEFAULT_MODEL = "whisper-1";
const MAX_BYTES = 25 * 1024 * 1024; // OpenAI's own cap

const transcribeAudioTool: ToolDefinition = {
  name: "transcribe_audio",
  description:
    "Transcribe an audio file using an OpenAI-compatible Whisper endpoint. `path` is the audio file in the sandbox (mp3, mp4, mpeg, mpga, m4a, wav, webm). Reads `OPENAI_AUDIO_URL` (default OpenAI), `OPENAI_AUDIO_KEY` (falls back to `MINIMAX_API_KEY`), `OPENAI_AUDIO_MODEL` (default `whisper-1`). Returns the transcript text. Files larger than 25 MiB are rejected. Mutating in the approval sense (uploads to a third party); prompts in `safe` AND `accept-edits`.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Audio file path, relative to the sandbox root." },
      language: {
        type: "string",
        description: "Optional ISO-639-1 language code, e.g. 'en' or 'es'. Skips auto-detect.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  preview: (args) =>
    `transcribe ${typeof args.path === "string" ? args.path : "?"}`,
  execute: async (args) => {
    try {
      const target = await resolveSafePath(String(args.path ?? ""));
      const s = await stat(target);
      if (!s.isFile()) return `Error: not a file: ${args.path}`;
      if (s.size > MAX_BYTES) return `Error: file too large (${(s.size / 1_048_576).toFixed(1)} MiB; cap 25 MiB)`;
      const url = process.env.OPENAI_AUDIO_URL ?? DEFAULT_URL;
      const key = process.env.OPENAI_AUDIO_KEY ?? process.env.MINIMAX_API_KEY;
      if (!key) {
        return "Error: OPENAI_AUDIO_KEY or MINIMAX_API_KEY env var is required";
      }
      const model = process.env.OPENAI_AUDIO_MODEL ?? DEFAULT_MODEL;
      const buf = await readFile(target);
      const ext = (extname(target).slice(1) || "bin").toLowerCase();
      const mime =
        ext === "mp3" ? "audio/mpeg"
        : ext === "mp4" ? "audio/mp4"
        : ext === "m4a" ? "audio/m4a"
        : ext === "wav" ? "audio/wav"
        : ext === "webm" ? "audio/webm"
        : "application/octet-stream";
      const fd = new FormData();
      fd.append("model", model);
      fd.append("file", new Blob([new Uint8Array(buf)], { type: mime }), basename(target));
      if (args.language) fd.append("language", String(args.language));
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: fd,
      });
      const txt = await res.text();
      if (!res.ok) {
        return `Error: ${url} returned ${res.status}: ${txt.slice(0, 300)}`;
      }
      try {
        const j = JSON.parse(txt) as { text?: string; [k: string]: unknown };
        return j.text ?? txt;
      } catch {
        return txt;
      }
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const audioTools: ToolDefinition[] = [transcribeAudioTool];
