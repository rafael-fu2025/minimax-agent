/**
 * `streamChat` — exercise the SSE parser by feeding canned byte streams
 * through a mocked `fetch`. Verifies that:
 *   1. Text deltas are accumulated.
 *   2. Tool-call fragments are assembled across chunks.
 *   3. The terminal `[DONE]` sentinel stops the generator.
 *   4. Usage chunks with `choices: []` are still yielded.
 *   5. A non-2xx response throws an Error.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Mock the key rotator so `streamChat` never touches the DB / keys layer.
 *
 * Why: `server/keys/index.ts` imports `server/db/index.ts`, whose very first
 * statement is `import "dotenv/config"`. When `.env` ships a `DATABASE_URL`,
 * `dotenv/config` re-sets it at module-init time, then `loadSources()` sees
 * `isDbConfigured() === true` and tries to open a pg pool. Without a running
 * Postgres, that hangs on `connectionTimeoutMillis: 5_000` — the same as
 * the global `testTimeout` — producing a flaky timeout race. Stubbing
 * `getRotator` short-circuits the entire chain so the test exercises only
 * the SSE parser.
 */
vi.mock("../../server/keys/rotator.js", () => ({
  getRotator: async () => ({
    call: async <T,>(fn: (secret: string) => Promise<T>): Promise<T> =>
      fn("sk-test-not-a-real-key"),
  }),
}));

/**
 * Build a fake `Response` whose `body.getReader()` emits the given byte
 * chunks one by one (the real SSE wire format uses `data: ...` lines
 * separated by blank lines, terminated by `data: [DONE]`).
 */
function makeSseResponse(chunks: string[], status = 200): Response {
  const enc = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(chunks[i]));
      i += 1;
    },
  });
  return new Response(stream, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

describe("streamChat", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("yields text deltas and stops on [DONE]", async () => {
    const events = await import("../../server/minimax.js");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeSseResponse([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const chunks = await collect(
      events.streamChat({ messages: [{ role: "user", content: "hi" }] }),
    );
    const text = chunks.map((c) => (c.delta ?? "")).join("");
    expect(text).toBe("Hello world");
  });

  it("assembles tool-call fragments across chunks", async () => {
    const events = await import("../../server/minimax.js");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeSseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"exec"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"command\\""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"ls\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const chunks = await collect(
      events.streamChat({ messages: [{ role: "user", content: "x" }] }),
    );
    const tcs = chunks.filter((c) => c.toolCall).map((c) => c.toolCall);
    expect(tcs).toHaveLength(1);
    expect(tcs[0]).toMatchObject({
      id: "c1",
      function: { name: "exec", arguments: '{"command":"ls"}' },
    });
  });

  it("yields a usage chunk even with empty choices", async () => {
    const events = await import("../../server/minimax.js");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeSseResponse([
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":7,"total_tokens":12}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const chunks = await collect(
      events.streamChat({ messages: [{ role: "user", content: "x" }] }),
    );
    const usage = chunks.find((c) => c.usage);
    expect(usage?.usage).toEqual({ promptTokens: 5, completionTokens: 7, totalTokens: 12 });
  });

  it("throws on a non-2xx response", async () => {
    const events = await import("../../server/minimax.js");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("upstream blew up", { status: 502, statusText: "Bad Gateway" }),
    );
    await expect(
      collect(
        events.streamChat({ messages: [{ role: "user", content: "x" }] }),
      ),
    ).rejects.toThrow(/MiniMax API error 502/);
  });
});
