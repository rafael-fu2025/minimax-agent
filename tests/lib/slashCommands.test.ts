/**
 * Unit tests for the pure slash-command helpers. The composer is wired
 * around `filterCommands` and `applyCommand`; the rest of the rendering
 * is best covered by the manual smoke flow.
 */
import { describe, expect, it } from "vitest";
import {
  applyCommand,
  buildHelpText,
  filterCommands,
  SLASH_COMMANDS,
} from "../../src/slashCommands";

describe("filterCommands", () => {
  it("returns null when the input has no /-prefixed token", () => {
    expect(filterCommands({ text: "hello world" })).toBeNull();
    expect(filterCommands({ text: "" })).toBeNull();
    expect(filterCommands({ text: "no slashes here" })).toBeNull();
  });

  it("opens when the input ends with /", () => {
    const f = filterCommands({ text: "/" });
    expect(f).not.toBeNull();
    expect(f!.matches.length).toBe(SLASH_COMMANDS.length);
    expect(f!.query).toBe("/");
  });

  it("filters by the active token", () => {
    const f = filterCommands({ text: "/re" });
    expect(f).not.toBeNull();
    // Slugs ordered by the COMMON_ORDER table: /rename (2) before /read (6).
    expect(f!.matches.map((c) => c.slug)).toEqual(["/rename", "/read"]);
  });

  it("returns null when no command matches the prefix", () => {
    expect(filterCommands({ text: "/zzz" })).toBeNull();
  });

  it("only considers the last token in the input", () => {
    // `/re` mid-sentence should NOT open the palette because the active
    // token starts with whitespace-prefixed content; the rule is that the
    // *last* token must start with `/`. We test by placing a non-slash
    // token at the end.
    expect(filterCommands({ text: "use the /re thing" })).toBeNull();
  });

  it("closes when the active token has whitespace after the slug", () => {
    // `/read foo` is a committed command; the palette should hide.
    expect(filterCommands({ text: "/read foo" })).toBeNull();
  });

  it("clamps a stale highlight to a valid index", () => {
    const f = filterCommands({ text: "/re", highlighted: 99 });
    expect(f).not.toBeNull();
    expect(f!.highlighted).toBe(0);
  });

  it("preserves a valid highlight", () => {
    const f = filterCommands({ text: "/re", highlighted: 1 });
    expect(f).not.toBeNull();
    expect(f!.highlighted).toBe(1);
  });
});

describe("applyCommand", () => {
  const find = (slug: string) => SLASH_COMMANDS.find((c) => c.slug === slug)!;

  it("rewrites a prompt command with a generic stub", () => {
    // The user types the actual path *after* the generated stub,
    // not glued onto the slug. So the input to applyCommand is the
    // bare slug, and the output is the placeholder prompt.
    expect(applyCommand("/read", find("/read"))).toBe(
      "Read a file from the workspace and summarize its contents. ",
    );
  });

  it("rewrites a prompt command without args using a generic stub", () => {
    const out = applyCommand("/read", find("/read"));
    expect(out.startsWith("Read a file")).toBe(true);
  });

  it("strips an action command from the input entirely", () => {
    expect(applyCommand("/clear", find("/clear"))).toBe("");
    expect(applyCommand("/help", find("/help"))).toBe("");
    expect(applyCommand("/rename", find("/rename"))).toBe("");
  });

  it("preserves the prefix before the active token", () => {
    expect(applyCommand("hello /read", find("/read"))).toBe(
      "hello Read a file from the workspace and summarize its contents. ",
    );
  });

  it("strips the active token for action commands", () => {
    // Action commands wipe the active token. The composer ends up
    // with whatever prefix the user had before the slug.
    expect(applyCommand("/clear", find("/clear"))).toBe("");
    expect(applyCommand("hi /clear", find("/clear"))).toBe("hi");
  });

  it("treats /search as a prompt command with a query placeholder", () => {
    expect(applyCommand("/search", find("/search"))).toBe(
      "Use web_search for: <your query>. ",
    );
  });
});

describe("buildHelpText", () => {
  it("lists every command", () => {
    const text = buildHelpText();
    for (const cmd of SLASH_COMMANDS) {
      expect(text).toContain(cmd.slug);
      expect(text).toContain(cmd.label);
    }
  });
});