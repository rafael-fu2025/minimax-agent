/**
 * `formatToolPreview` — table-driven tests for the per-tool preview
 * pipeline. Each row asserts both the per-tool preview (when one exists)
 * and the JSON-stringify fallback (when it doesn't).
 *
 * The collapsed `formatToolPreview` is intentionally minimal: per-tool
 * previews live on `ToolDefinition.preview`. If a registry is passed in
 * and the tool has a `preview` function, it's used; otherwise we fall back
 * to pretty-printed JSON (or the raw string when the JSON is malformed).
 */
import { describe, expect, it } from "vitest";
import { formatToolPreview } from "../../server/tools/approval.js";
import type { ToolDefinition } from "../../server/tools.js";

function makeTool(name: string, preview: (args: Record<string, unknown>) => string): ToolDefinition {
  return {
    name,
    description: "test",
    parameters: { type: "object", properties: {} },
    execute: async () => "",
    preview,
  };
}

describe("formatToolPreview", () => {
  const tools: ToolDefinition[] = [
    makeTool("exec_command", (a) => {
      const cmd = typeof a.command === "string" ? a.command : "";
      const tmo = typeof a.timeout_ms === "number" ? `   (timeout ${a.timeout_ms}ms)` : "";
      return `$ ${cmd}${tmo}`;
    }),
    makeTool("write_file", (a) => {
      const p = typeof a.path === "string" ? a.path : "(unknown path)";
      const append = a.append ? "  [append]" : "";
      return `write → ${p}${append}`;
    }),
    makeTool("delete_file", (a) => `delete → ${typeof a.path === "string" ? a.path : "(unknown path)"}`),
    makeTool("move_file", (a) => `move ${a.from ?? "?"} → ${a.to ?? "?"}`),
    makeTool("create_directory", (a) => `mkdir ${a.path ?? "?"}`),
    makeTool("patch_file", (a) => `patch → ${a.path ?? "?"}`),
    makeTool("diff_files", (a) => `diff ${a.a ?? "?"} ${a.b ?? "?"}`),
    makeTool("code_search", (a) => `/${a.pattern ?? "?"}/`),
    makeTool("list_processes", (a) => (typeof a.filter === "string" ? `ps aux | grep ${a.filter}` : "ps aux")),
    makeTool("kill_process", (a) => `kill ${typeof a.pid === "number" ? String(a.pid) : "?"}`),
    makeTool("env_get", (a) => (typeof a.name === "string" ? `echo $${a.name}` : "env")),
    makeTool("fetch_url", (a) => `${String(a.method ?? "GET")} ${a.url ?? "?"}`),
    makeTool("git_query", (a) => `git ${String(a.subcommand ?? "status")}`),
    makeTool("archive_zip", (a) => `zip ${a.src_dir ?? "?"} → ${a.dest_path ?? "?"}`),
    makeTool("archive_unzip", (a) => `unzip ${a.src_path ?? "?"} → ${a.dest_dir ?? "?"}`),
    makeTool("pdf_read", (a) => `pdf ${a.path ?? "?"}`),
    makeTool("format_code", (a) => `format ${a.path ?? "?"} (${a.tool ?? "prettier"})`),
    makeTool("transcribe_audio", (a) => `transcribe ${a.path ?? "?"}`),
    makeTool("image_generate", (a) => {
      const p = typeof a.prompt === "string" ? a.prompt.slice(0, 60) : "?";
      return `image "${p}"`;
    }),
    makeTool("run_python", (a) => `python ${typeof a.path === "string" ? a.path : "<inline>"}`),
    makeTool("schedule_task", (a) => `schedule ${a.tool ?? "?"} at ${a.when ?? "?"}`),
  ];

  const cases: Array<{ tool: string; args: string; expected: string }> = [
    { tool: "exec_command", args: '{"command":"ls -la","timeout_ms":5000}', expected: "$ ls -la   (timeout 5000ms)" },
    { tool: "write_file", args: '{"path":"docs/x.md"}', expected: "write → docs/x.md" },
    { tool: "write_file", args: '{"path":"docs/x.md","append":true}', expected: "write → docs/x.md  [append]" },
    { tool: "delete_file", args: '{"path":"scratch.txt"}', expected: "delete → scratch.txt" },
    { tool: "move_file", args: '{"from":"a","to":"b"}', expected: "move a → b" },
    { tool: "create_directory", args: '{"path":"new/dir"}', expected: "mkdir new/dir" },
    { tool: "patch_file", args: '{"path":"file.ts"}', expected: "patch → file.ts" },
    { tool: "diff_files", args: '{"a":"x","b":"y"}', expected: "diff x y" },
    { tool: "code_search", args: '{"pattern":"TODO"}', expected: "/TODO/" },
    { tool: "list_processes", args: '{"filter":"node"}', expected: "ps aux | grep node" },
    { tool: "list_processes", args: '{}', expected: "ps aux" },
    { tool: "kill_process", args: '{"pid":4242}', expected: "kill 4242" },
    { tool: "env_get", args: '{"name":"PATH"}', expected: "echo $PATH" },
    { tool: "fetch_url", args: '{"method":"POST","url":"https://api.example.com/x"}', expected: "POST https://api.example.com/x" },
    { tool: "git_query", args: '{"subcommand":"log"}', expected: "git log" },
    { tool: "archive_zip", args: '{"src_dir":"docs","dest_path":"docs.zip"}', expected: "zip docs → docs.zip" },
    { tool: "archive_unzip", args: '{"src_path":"x.zip","dest_dir":"out"}', expected: "unzip x.zip → out" },
    { tool: "pdf_read", args: '{"path":"doc.pdf"}', expected: "pdf doc.pdf" },
    { tool: "format_code", args: '{"path":"index.ts","tool":"prettier"}', expected: "format index.ts (prettier)" },
    { tool: "transcribe_audio", args: '{"path":"a.mp3"}', expected: "transcribe a.mp3" },
    { tool: "image_generate", args: '{"prompt":"a sunset"}', expected: 'image "a sunset"' },
    { tool: "run_python", args: '{"path":"scripts/x.py"}', expected: "python scripts/x.py" },
    { tool: "schedule_task", args: '{"tool":"exec","when":"in 5m"}', expected: "schedule exec at in 5m" },
  ];

  for (const { tool, args, expected } of cases) {
    it(`${tool} -> ${expected}`, () => {
      expect(formatToolPreview(tool, args, tools)).toBe(expected);
    });
  }

  it("falls back to JSON when no registry is supplied", () => {
    const out = formatToolPreview("unknown_tool", '{"x":1,"y":"z"}');
    expect(out).toContain('"x": 1');
    expect(out).toContain('"y": "z"');
  });

  it("falls back to JSON when tool is missing from the registry", () => {
    const out = formatToolPreview("not_registered", '{"x":1}');
    expect(out).toContain('"x": 1');
  });

  it("returns the raw string when arguments are not valid JSON", () => {
    const out = formatToolPreview("exec_command", "{not json", tools);
    expect(out).toBe("{not json");
  });
});