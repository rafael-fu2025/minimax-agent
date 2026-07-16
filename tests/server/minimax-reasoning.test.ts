// filepath: tests/server/minimax-reasoning.test.ts
//
// Regression tests for the
// "model emits a stray  tag at the start of delta.content" bug.
//
// Before the fix the server forwarded delta.content verbatim and the
// client had no way to know that  without a preceding
//  was safe to discard. The result was a visible-text message that
// started with the literal markup, e.g. "…final answer",
// followed by a stream of empty Thinking toggles.

import { describe, it, expect, vi } from "vitest";
import { ReadableStream } from "node:stream/web";

// Mock the key rotator so streamChat() can boot without a DB.
vi.mock("../../server/keys/rotator.js", () => ({
  getRotator: () => ({
    async call<T>(fn: (secret: string) => Promise<T>): Promise<T> {
      return fn("test-key");
    },
  }),
}));

import { streamChat, stripStrayThinkTags } from "../../server/minimax.js";

function sseResponse(events: unknown[]): Response {
  const enc = new TextEncoder();
  const payload = events
    .map((e) => `data: ${JSON.stringify(e)}\n\n`)
    .join("");
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode(payload));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    },
  );
}

describe("stripStrayThinkTags", () => {
  it("removes a lone closing tag", () => {
    expect(stripStrayThinkTags("answer")).toBe("answer");
  });
  it("removes a lone opening tag", () => {
    expect(stripStrayThinkTags("reasoning")).toBe("reasoning");
  });
  it("removes both halves of a stray pair", () => {
    expect(stripStrayThinkTags("reasoninganswer")).toBe(
      "reasoninganswer",
    );
  });
  it("preserves non-think content unchanged", () => {
    expect(stripStrayThinkTags("plain text")).toBe("plain text");
  });
  it("is a no-op on the empty string", () => {
    expect(stripStrayThinkTags("")).toBe("");
  });
});

describe("streamChat — reasoning + stray-tag handling", () => {
  it("forwards delta.reasoning_content as a `reasoning` chunk", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        {
          choices: [
            {
              delta: { reasoning_content: "thinking out loud" },
            },
          ],
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out: string[] = [];
    for await (const chunk of streamChat({
      messages: [{ role: "user", content: "hi" }],
    })) {
      if (chunk.reasoning) out.push(chunk.reasoning);
    }
    expect(out).toEqual(["thinking out loud"]);
    vi.unstubAllGlobals();
  });

  it("strips a stray leading  from delta.content", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        {
          choices: [
            {
              delta: { content: "</think>The final answer" },
            },
          ],
        },
        {
          choices: [{ finish_reason: "stop", delta: {} }],
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const deltas: string[] = [];
    for await (const chunk of streamChat({
      messages: [{ role: "user", content: "hi" }],
    })) {
      if (chunk.delta) deltas.push(chunk.delta);
    }
    // The stray closing tag is consumed by the server; the client only
    // sees the visible answer.
    expect(deltas.join("")).toBe("The final answer");
    vi.unstubAllGlobals();
  });


  it("preserves tags embedded inside non-tag text", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        { choices: [{ delta: { content: "<not>think</not>" } }] },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const deltas: string[] = [];
    for await (const chunk of streamChat({
      messages: [{ role: "user", content: "hi" }],
    })) {
      if (chunk.delta) deltas.push(chunk.delta);
    }
    // "<not>think</not>" contains the substring "think" but inside other
    // tags, so the regex must not strip it.
    expect(deltas.join("")).toBe("<not>think</not>");
    vi.unstubAllGlobals();
  });
});