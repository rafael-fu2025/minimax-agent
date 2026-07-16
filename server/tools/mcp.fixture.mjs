#!/usr/bin/env node
/**
 * Minimal MCP (Model Context Protocol) test fixture. Speaks JSON-RPC 2.0
 * over stdio. Exposes two tools:
 *
 *   - echo(text: string) -> the same text
 *   - add(a: number, b: number) -> a + b
 *
 * Run via the smoke test:
 *   MCP_SERVERS='[{"name":"dummy","command":"node","args":["server/tools/mcp.fixture.mjs"]}]' \
 *     npm run dev:server
 *
 * Then ask the agent: "Use mcp_dummy_echo to say hello" and watch the tool
 * land in the registry + get called.
 */

import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";

const SERVER_INFO = { name: "dummy-mcp", version: "0.1.0" };
const TOOLS = [
  {
    name: "echo",
    description: "Returns the input text unchanged.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Text to echo." } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "add",
    description: "Adds two numbers and returns the sum.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number", description: "First addend." },
        b: { type: "number", description: "Second addend." },
      },
      required: ["a", "b"],
      additionalProperties: false,
    },
  },
];

let nextId = 1;
function respond(id, result) {
  const line = JSON.stringify({ jsonrpc: "2.0", id, result });
  stdout.write(line + "\n");
}
function respondError(id, code, message) {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
  stdout.write(line + "\n");
}

const rl = createInterface({ input: stdin, crlfDelay: Infinity });
let buffer = "";
rl.on("line", (line) => {
  buffer += line + "\n";
  // Each request is a single line. We process one per tick.
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = req;
  switch (method) {
    case "initialize":
      respond(id, { protocolVersion: "2024-11-05", serverInfo: SERVER_INFO, capabilities: { tools: {} } });
      break;
    case "notifications/initialized":
      // No response.
      break;
    case "tools/list":
      respond(id, { tools: TOOLS });
      break;
    case "tools/call": {
      const { name, arguments: args } = params ?? {};
      if (name === "echo") {
        const text = String(args?.text ?? "");
        respond(id, { content: [{ type: "text", text }] });
      } else if (name === "add") {
        const a = Number(args?.a ?? 0);
        const b = Number(args?.b ?? 0);
        respond(id, { content: [{ type: "text", text: String(a + b) }] });
      } else {
        respondError(id, -32601, `Unknown tool: ${name}`);
      }
      break;
    }
    default:
      respondError(id, -32601, `Unknown method: ${method}`);
  }
  void nextId++;
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
