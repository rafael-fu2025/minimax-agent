// filepath: src/emptyStateCopy.ts
/**
 * Centralized user-facing strings for the chat empty state.
 *
 * Keeping these in a dedicated module (rather than inlined in the JSX)
 * makes it easy to find copy, run translation passes, and keep voice
 * consistent across the app. Treat this as the source of truth — UI
 * components should not redeclare the same phrases.
 */

export interface EmptyStateSuggestion {
  /** Visible button label. */
  label: string;
  /** The actual prompt sent when the user activates the suggestion. */
  prompt: string;
}

export interface EmptyStateCopy {
  title: string;
  description: string;
  /** Quick-action buttons rendered under the description. */
  suggestions: readonly EmptyStateSuggestion[];
}

/** Copy shown when the chat has no messages yet. */
export const EMPTY_STATE: EmptyStateCopy = {
  title: "Start a new conversation",
  description:
    "Ask a question, request a calculation, or have the agent read a file from your workspace. Tool calls will appear inline as it works.",
  suggestions: [
    {
      label: "Calculate 17 * 23 + sqrt(144)",
      prompt: "What is 17 * 23 + sqrt(144)?",
    },
    {
      label: "Current time in Tokyo",
      prompt: "What time is it in Tokyo?",
    },
    {
      label: "List my workspace files",
      prompt: "Use list_dir to show what's in the workspace root.",
    },
  ],
};