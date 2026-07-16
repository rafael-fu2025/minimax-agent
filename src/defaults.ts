// filepath: src/defaults.ts
import { newId } from "./conversations";
import type { UiMessage } from "./types";

/**
 * Welcome message shown the first time someone opens the app.
 * Plain prose, no emoji, no marketing fluff.
 */
export const welcomeMessage: UiMessage = {
  id: newId(),
  role: "assistant",
  content: [
    "This is an agentic chat built on Meta's Astryx design system and powered by MiniMax.",
    "",
    "Try one of these to see the tool-calling loop in action:",
    "",
    "1. Ask me to calculate an expression — I'll use the `calculate` tool.",
    "2. Ask me for the current time in a city — I'll use `get_current_time`.",
    "3. Ask me to read or list files in the sandbox — I'll use `read_file` / `list_dir`.",
    "",
    "Use the model selector in the top bar to switch between MiniMax models.",
    "Conversations are stored in this browser's localStorage.",
    "Web search needs the MiniMax MCP wired in `MCP_SERVERS` (see Settings → Server).",
  ].join("\n"),
  status: "done",
};