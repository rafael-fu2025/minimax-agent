/**
 * `globToRegExp` — table-driven tests for the search_files glob engine.
 *
 * Each row in `cases` is `{ pattern, path, expected }`. `path` is the
 * candidate filename (always a relative path, no leading `./`). The
 * implementation matches the entire string, anchored at both ends.
 */
import { describe, expect, it } from "vitest";
import { globToRegExp } from "../../server/tools/fs.js";

describe("globToRegExp", () => {
  const cases: Array<{ pattern: string; path: string; expected: boolean }> = [
    // Literal match
    { pattern: "README.md", path: "README.md", expected: true },
    { pattern: "README.md", path: "docs/README.md", expected: false },

    // Single-segment `*`
    { pattern: "*.ts", path: "index.ts", expected: true },
    { pattern: "*.ts", path: "src/index.ts", expected: false },
    { pattern: "*.ts", path: "src/nested/index.ts", expected: false },

    // Recursive `**` — matches across path separators
    { pattern: "**/*.ts", path: "index.ts", expected: true },
    { pattern: "**/*.ts", path: "src/index.ts", expected: true },
    { pattern: "**/*.ts", path: "src/nested/deep/index.ts", expected: true },
    { pattern: "**/*.ts", path: "README.md", expected: false },

    // Path-scoped `**` — `src/**` matches anything under src/
    { pattern: "src/**", path: "src/index.ts", expected: true },
    { pattern: "src/**", path: "src/components/Foo.tsx", expected: true },
    { pattern: "src/**", path: "docs/index.md", expected: false },

    // `?` — exactly one non-separator character
    { pattern: "file?.txt", path: "file1.txt", expected: true },
    { pattern: "file?.txt", path: "file.txt", expected: false },
    { pattern: "file?.txt", path: "file12.txt", expected: false },

    // Bracket expansion — character class
    { pattern: "data[abc].csv", path: "dataa.csv", expected: true },
    { pattern: "data[abc].csv", path: "datad.csv", expected: false },

    // Glob special characters in the path stay literal
    { pattern: "weird.name+1", path: "weird.name+1", expected: true },
    { pattern: "weird.name+1", path: "weird-name-1", expected: false },
  ];

  for (const { pattern, path, expected } of cases) {
    it(`${pattern} ${expected ? "matches" : "does not match"} ${path}`, () => {
      const re = globToRegExp(pattern);
      expect(re.test(path)).toBe(expected);
    });
  }
});