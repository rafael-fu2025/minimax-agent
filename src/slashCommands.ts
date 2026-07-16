/**
 * Slash command catalog and pure filter logic for the chat composer.
 *
 * The palette is shown when the user types `/` at the start of a token (no
 * whitespace immediately after the slash). The filter is a deterministic
 * pure function so the rules can be unit-tested without a renderer.
 *
 * Each command has a `kind`:
 *   - "prompt"  : a stub is injected into the composer text and the user
 *                 sends a real message (the LLM picks the right tool).
 *   - "action"  : executed immediately, no message sent.
 *
 * `keybinding` is shown as a hint chip. Only one key per command today; we
 * keep the field array-shaped so the catalog can grow without a refactor.
 */

export type SlashCommandKind = "prompt" | "action";

export interface SlashCommand {
  /** Slug including the leading slash, e.g. "/read". */
  slug: string;
  /** One-line label shown in the menu. */
  label: string;
  /** Short description shown under the label. */
  description: string;
  /** "prompt" sends a message; "action" runs immediately. */
  kind: SlashCommandKind;
  /**
   * Optional keybinding hint. Empty string hides the chip.
   * Keep these platform-agnostic (e.g. "Tab", "/") so the UI can decorate.
   */
  keybinding?: string;
  /**
   * When true, the active token may include whitespace after the slug.
   * Use this for action commands that take inline arguments, e.g.
   * `/rename My new title`. Defaults to false because the typical flow
   * is to pick a prompt command and type arguments *after* the stub.
   */
  acceptsArgs?: boolean;
  /**
   * Build the text that replaces the `/slug ...` token in the composer
   * when the command is a "prompt". Returning a string that already
   * contains the user's typed argument (e.g. the path the user wrote
   * after `/read`) keeps the message rich without re-typing.
   */
  buildPrompt?: (args: string) => string;
  /**
   * Optional grouping tag for future filter facets. Today the menu just
   * uses it to sort a small handful of "common" commands to the top.
   */
  tag?: "common" | "files" | "compute" | "system";
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    slug: "/help",
    label: "Help",
    description: "Show every slash command and what it does.",
    kind: "action",
    keybinding: "?",
    tag: "system",
  },
  {
    slug: "/clear",
    label: "Clear conversation",
    description: "Reset the current thread back to the welcome message.",
    kind: "action",
    tag: "system",
  },
  {
    slug: "/rename",
    label: "Rename conversation",
    description: "Set this conversation title. Usage: /rename My new title",
    kind: "action",
    acceptsArgs: true,
    keybinding: "Tab",
    tag: "system",
  },
  {
    slug: "/read",
    label: "Read file",
    description: "Read a sandbox file and inline its contents. Usage: /read path",
    kind: "prompt",
    buildPrompt: (args) =>
      args ? `Read \`${args}\` and summarize the key points.` : "Read a file from the workspace and summarize its contents.",
    tag: "files",
  },
  {
    slug: "/list",
    label: "List directory",
    description: "List the files in a sandbox directory. Usage: /list [path]",
    kind: "prompt",
    buildPrompt: (args) =>
      args ? `Use list_dir to show what's in \`${args}\`.` : "Use list_dir to show what's in the workspace root.",
    tag: "files",
  },
  {
    slug: "/search",
    label: "Web search",
    description: "Run a web search and add the results to your reply. Usage: /search query",
    kind: "prompt",
    buildPrompt: (args) => `Use web_search for: ${args || "<your query>"}.`,
    tag: "common",
  },
  {
    slug: "/calc",
    label: "Calculate",
    description: "Evaluate a math expression. Usage: /calc 17 * 23 + sqrt(144)",
    kind: "prompt",
    buildPrompt: (args) => `What is ${args || "<expression>"}?`,
    tag: "common",
  },
  {
    slug: "/time",
    label: "Current time",
    description: "Get the current time, optionally in a timezone. Usage: /time [tz]",
    kind: "prompt",
    buildPrompt: (args) =>
      args ? `What time is it in ${args}?` : "What is the current time?",
    tag: "common",
  },
  {
    slug: "/python",
    label: "Run Python",
    description: "Execute a Python file or inline expression. Usage: /python [path|inline]",
    kind: "prompt",
    buildPrompt: (args) => `Run Python: ${args || "<inline expression or path>"}.`,
    tag: "compute",
  },
  {
    slug: "/image",
    label: "Generate image",
    description: "Generate an image from a prompt. Usage: /image a sunset over the bay",
    kind: "prompt",
    buildPrompt: (args) => `Generate an image: ${args || "<prompt>"}.`,
    tag: "compute",
  },
];

/**
 * Result of running `filterCommands` against a composer snapshot.
 *
 * The composer pass is intentionally tiny: we only consider the LAST token
 * of the trimmed input, so `Hello /re` does NOT trigger the palette (the
 * `/re` is mid-sentence). Only an `/`-prefixed token at the end of the
 * current input counts.
 */
export interface SlashFilter {
  /** The matching commands, already ordered for the menu. */
  matches: SlashCommand[];
  /** Index of the highlighted row, or 0 when there are no matches. */
  highlighted: number;
  /** The raw token that triggered the palette, e.g. "/re". */
  query: string;
  /**
   * The text that should remain in the composer after the user picks a
   * command. This is `null` for "prompt" commands (the prompt helper
   * rewrites it) and a non-null value for "action" commands (the original
   * token is removed; the composer empties back to "").
   */
  replacement: string | null;
}

export interface FilterInput {
  /** Full composer text. */
  text: string;
  /** Currently highlighted row from a prior render; defaults to 0. */
  highlighted?: number;
}

const COMMON_ORDER: Record<string, number> = { "/help": 0, "/clear": 1, "/rename": 2, "/search": 3, "/calc": 4, "/time": 5, "/read": 6, "/list": 7, "/python": 8, "/image": 9 };

/**
 * Decide whether the palette should be visible for the given composer text.
 *
 * Returns `null` when no `/`-prefixed token is in flight (caller hides the
 * menu). Otherwise returns the visible matches plus the suggested
 * highlighted row.
 */
export function filterCommands(input: FilterInput): SlashFilter | null {
  const text = input.text;
  // We only consider the LAST token so users can type a sentence ending
  // with `/` (e.g. "Use the / command...") without the palette opening.
  // The "active token" is everything after the last whitespace.
  const start = Math.max(text.lastIndexOf(" "), text.lastIndexOf("\n")) + 1;
  const active = text.slice(start);
  if (!active.startsWith("/")) return null;
  // The user must still be editing the slug — if they typed a space, the
  // command is "committed" and the palette should hide.
  // Allow embedded whitespace inside an arg so `/read foo bar` keeps the
  // slug live until the user hits space at all. To do that we require the
  // active token to start with `/` and contain NO whitespace.
  // The active token must be only the slug UNLESS the user is mid-
  // typing an argument for an action command that accepts one. To keep
  // the rule simple we allow whitespace and re-filter the matches:
  // any command whose slug equals the head of the active token (and
  // accepts args) keeps the menu live.
  if (/\s/.test(active)) {
    const head = active.split(/\s+/, 1)[0];
    const live = SLASH_COMMANDS.some(
      (c) => c.acceptsArgs && c.slug === head,
    );
    if (!live) return null;
  }

  const query = active.toLowerCase();
  const matches = SLASH_COMMANDS
    .filter((cmd) => cmd.slug.startsWith(query))
    .slice()
    .sort((a, b) => {
      // Prefer the user-specified COMMON_ORDER; fall back to slug alpha.
      const ao = COMMON_ORDER[a.slug] ?? 99;
      const bo = COMMON_ORDER[b.slug] ?? 99;
      if (ao !== bo) return ao - bo;
      return a.slug.localeCompare(b.slug);
    });

  if (matches.length === 0) return null;

  const highlighted =
    typeof input.highlighted === "number" && input.highlighted >= 0 &&
    input.highlighted < matches.length
      ? input.highlighted
      : 0;

  return {
    matches,
    highlighted,
    query: active,
    replacement: null,
  };
}

/**
 * Build the text that should replace the active token once the user
 * activates a command. For "action" commands the active token is removed
 * entirely (the composer goes back to whatever was before it). For
 * "prompt" commands the slug is replaced with the prompt stub, preserving
 * the user's args where appropriate.
 */
export function applyCommand(
  text: string,
  command: SlashCommand,
): string {
  // The active token is the chunk of `text` after the last whitespace.
  // When the menu is open the active token is always the slug (the
  // filter requires no whitespace in the active token), so we just
  // replace it. Args for prompt commands are typed *after* the
  // generated stub, not glued onto the slug.
  const lastSpace = Math.max(text.lastIndexOf(" "), text.lastIndexOf("\n"));
  const tokenStart = lastSpace + 1;
  const prefix = text.slice(0, tokenStart);
  if (command.kind === "action") {
    if (command.acceptsArgs) {
      // /rename <title>: strip the slug and the args, but the parent
      // will read the title from the second onSlashCommand arg via the
      // caller (the composer still computes the new text using the
      // prefix, the stub (empty here), and a trailing space if useful).
      return prefix.trimEnd();
    }
    // Strip the active token entirely; the composer ends up with just
    // the prefix (which the caller will trim/extend as needed). For
    // `/clear` at the start of an empty draft this collapses to "".
    return prefix.trimEnd();
  }
  // Prompt stubs include a placeholder for the user to overwrite (or
  // just keep typing after the trailing space).
  const body = command.buildPrompt
    ? command.buildPrompt("")
    : command.slug;
  return prefix + body + " ";
}

/**
 * Convenience: build the help text shown in the help toast. Kept here so
 * the menu and the toast stay in sync with the catalog.
 */
export function buildHelpText(): string {
  return SLASH_COMMANDS
    .map((c) => {
      const binding = c.keybinding ? ` (${c.keybinding})` : "";
      return `${c.slug} — ${c.label}${binding}: ${c.description}`;
    })
    .join("\n");
}