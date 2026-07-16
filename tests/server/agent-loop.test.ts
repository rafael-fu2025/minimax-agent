// filepath: tests/server/agent-loop.test.ts
//
// Regression tests for the "agent loop terminates the run mid-thought when
// the model makes lots of tool calls" bug.
//
// Before the fix, the agent loop had a hard cap of MAX_TURNS=6 and ended
// the SSE stream with `{ type: "done", finishReason: "max_turns" }` while
// the model was still planning or executing more tool calls. The user
// saw the response cut off with no `done` event and no final summary.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Writable } from "node:stream";

// Mock the key rotator + tools + approvals so we can exercise the agent
// loop end-to-end without making real LLM calls.
const streamChatMock = vi.fn();
const runToolMock = vi.fn();
const awaitApprovalMock = vi.fn();

vi.mock("../../server/keys/rotator.js", () => ({
  getRotator: () => ({
    async call<T>(fn: (secret: string) => Promise<T>): Promise<T> {
      return fn("test-key");
    },
  }),
}));

vi.mock("../../server/minimax.js", () => ({
  streamChat: (...args: unknown[]) => streamChatMock(...args),
}));
vi.mock("../../server/tools.js", () => ({
  runTool: (...args: unknown[]) => runToolMock(...args),
  tools: [],
  toolSchemas: [],
}));
vi.mock("../../server/approvals.js", () => ({
  awaitApproval: (...args: unknown[]) => awaitApprovalMock(...args),
}));

// Imported AFTER the mocks are declared so they take effect.
import { runAgent } from "../../server/agent.js";

/**
 * Capture every SSE event the agent loop writes to the response.
 */
function captureEvents() {
  const events: Array<Record<string, unknown>> = [];
  const res = new Writable({
    write(chunk, _enc, cb) {
      const raw = chunk.toString("utf8");
      for (const part of raw.split("\n\n")) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          events.push(JSON.parse(payload));
        } catch {
          // ignore non-JSON keep-alives
        }
      }
      cb();
    },
  });
  // The agent reads several Express-specific fields off `res`. Faking the
  // bare minimum keeps the loop happy in the test environment.
  (res as unknown as { setHeader: () => void }).setHeader = () => {};
  (res as unknown as { flushHeaders: () => void }).flushHeaders = () => {};
  return { res: res as unknown as Parameters<typeof runAgent>[1], events };
}

const NEVER_ABORTED = new AbortController().signal;

beforeEach(() => {
  streamChatMock.mockReset();
  runToolMock.mockReset();
  awaitApprovalMock.mockReset();
});

describe("runAgent — multi-turn tool-using loop", () => {
  it("keeps going past 6 turns and streams the final summary text", async () => {
    // Schedule: 7 rounds. Rounds 1-6 each emit text + one tool call.
    // Round 7 streams the final summary and a stop finish_reason. The
    // agent should not bail out at MAX_TURNS=6 — it should keep looping
    // until the model stops calling tools.
    let calls = 0;
    streamChatMock.mockImplementation(async function* () {
      calls += 1;
      // Round 1-6: text + one tool call + finish_reason=tool_calls.
      if (calls <= 6) {
        yield {
          delta: `exploring step ${calls} `,
          usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
        };
        yield {
          toolCall: {
            id: `tc-${calls}`,
            type: "function",
            function: { name: "read_file", arguments: "{\"path\":\"/x\"}" },
          },
        };
        yield { finishReason: "tool_calls" };
        return;
      }
      // Round 7: final summary, no tool calls, finish_reason=stop.
      yield {
        delta: "All done — here is the final analysis.",
        usage: { promptTokens: 8, completionTokens: 3, totalTokens: 11 },
      };
      yield { finishReason: "stop" };
    });
    runToolMock.mockResolvedValue("ok");
    awaitApprovalMock.mockResolvedValue("allow");

    const { res, events } = captureEvents();
    await runAgent(
      { messages: [{ role: "user", content: "analyze" }] },
      res,
      NEVER_ABORTED,
    );

    // The agent should have called streamChat 7 times — proving the cap
    // is no longer hard-blocking on round 6.
    expect(streamChatMock).toHaveBeenCalledTimes(7);

    // Final assistant turn reached the client.
    const textEvents = events
      .filter((e) => e.type === "text")
      .map((e) => e.delta as string);
    expect(textEvents.join("")).toContain("All done");
    expect(textEvents.join("")).toContain("exploring step 6 ");

    // A `done` event with finishReason=stop marks a clean finish.
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(done?.finishReason).toBe("stop");
  });

  it("emits done + persists trailing text when the turn cap is reached", async () => {
    // The agent must still send `done` when it bails out at the safety cap,
    // and persist the trailing assistant text so it isn't lost. Before
    // the fix the response stream could close without a final summary and
    // a missing `done`, leaving the client in a "streaming" state forever.
    let calls = 0;
    streamChatMock.mockImplementation(async function* () {
      calls += 1;
      // Every turn emits text + a tool call + finish_reason=tool_calls.
      // The loop should keep going up to the cap and then exit cleanly.
      yield {
        delta: `chunk ${calls} `,
        usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6 },
      };
      yield {
        toolCall: {
          id: `tc-${calls}`,
          type: "function",
          function: { name: "read_file", arguments: "{\"path\":\"/y\"}" },
        },
      };
      yield { finishReason: "tool_calls" };
    });
    runToolMock.mockResolvedValue("ok");
    awaitApprovalMock.mockResolvedValue("allow");

    const { res, events } = captureEvents();
    await runAgent(
      {
        messages: [{ role: "user", content: "analyze" }],
        // Force a tiny cap so the test runs fast.
        maxTurns: 3,
      },
      res,
      NEVER_ABORTED,
    );

    expect(streamChatMock).toHaveBeenCalledTimes(3);

    // Trailing text from the last turn reached the client.
    const textDeltas = events
      .filter((e) => e.type === "text")
      .map((e) => e.delta as string);
    expect(textDeltas.join("")).toContain("chunk 3 ");

    // The loop must close the stream with a `done` event, even on cap,
    // so the client can mark the message as finished instead of stuck.
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    // Cap-exit path uses a "truncated" finish reason so the client can
    // surface a hint that the model's turn was cut short.
    expect(done?.finishReason).toBe("truncated");
  });

  it("clamps absurdly large maxTurns to ABSOLUTE_MAX_TURNS", async () => {
    let calls = 0;
    streamChatMock.mockImplementation(async function* () {
      calls += 1;
      yield {
        delta: `x `,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
      yield {
        toolCall: {
          id: `tc-${calls}`,
          type: "function",
          function: { name: "read_file", arguments: "{}" },
        },
      };
      yield { finishReason: "tool_calls" };
    });
    runToolMock.mockResolvedValue("ok");
    awaitApprovalMock.mockResolvedValue("allow");

    const { res, events } = captureEvents();
    await runAgent(
      {
        messages: [{ role: "user", content: "huge" }],
        // Anything above ABSOLUTE_MAX_TURNS (50) must be clamped.
        maxTurns: 1_000_000,
      },
      res,
      NEVER_ABORTED,
    );

    // streamChat should have been called at most ABSOLUTE_MAX_TURNS + 1
    // times (since the loop runs `turn < maxTurns`). With the ceiling
    // applied, we expect 50 calls — not a million.
    expect(streamChatMock.mock.calls.length).toBeLessThanOrEqual(50);
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
  });

  it("sends done + trailing usage when the user aborts mid-turn", async () => {
    const controller = new AbortController();
    streamChatMock.mockImplementation(async function* () {
      yield { delta: "first half ", usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6 } };
      // The user stops the request — the loop must still flush `done`.
      controller.abort();
      // The next yield simulates the upstream stream reacting to the abort
      // signal and closing cleanly.
      return;
    });

    const { res, events } = captureEvents();
    await runAgent(
      { messages: [{ role: "user", content: "stop me" }] },
      res,
      controller.signal,
    );

    const textDeltas = events
      .filter((e) => e.type === "text")
      .map((e) => e.delta as string);
    expect(textDeltas.join("")).toContain("first half");

    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    // Aborted runs surface an explicit "aborted" finish reason so the
    // client UI can render the correct affordance.
    expect(done?.finishReason).toBe("aborted");
  });
});