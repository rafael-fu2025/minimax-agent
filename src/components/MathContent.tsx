import type { ReactNode } from "react";
import katex from "katex";
import { Markdown } from "@astryxdesign/core/Markdown";

/* -------------------------------------------------------------------------- */
/* Math rendering (KaTeX)                                                       */
/* -------------------------------------------------------------------------- */

type MathSegment =
  | { kind: "text"; text: string }
  | { kind: "math-block"; text: string }
  | { kind: "math-inline"; text: string };

/**
 * Split a string into text + math segments. `$$...$$` is a block, `$...$`
 * is inline. The parser is greedy on block math first (longest match
 * wins) so `$$x$$` doesn't get parsed as two inline `$x$` runs.
 */
export function splitMathSegments(content: string): MathSegment[] {
  const segments: MathSegment[] = [];
  let rest = content;
  while (rest.length > 0) {
    const blockMatch = rest.match(/\$\$([\s\S]+?)\$\$/);
    if (blockMatch && blockMatch.index !== undefined) {
      if (blockMatch.index > 0) {
        segments.push({ kind: "text", text: rest.slice(0, blockMatch.index) });
      }
      segments.push({ kind: "math-block", text: blockMatch[1].trim() });
      rest = rest.slice(blockMatch.index + blockMatch[0].length);
      continue;
    }
    const inlineMatch = rest.match(/\$([^\n\r$]+?)\$(?!\$)/);
    if (inlineMatch && inlineMatch.index !== undefined) {
      if (inlineMatch.index > 0) {
        segments.push({ kind: "text", text: rest.slice(0, inlineMatch.index) });
      }
      segments.push({ kind: "math-inline", text: inlineMatch[1] });
      rest = rest.slice(inlineMatch.index + inlineMatch[0].length);
      continue;
    }
    segments.push({ kind: "text", text: rest });
    break;
  }
  return segments;
}

/**
 * Render a LaTeX string via KaTeX. `throwOnError: false` makes mid-stream
 * partial LaTeX (e.g. `$\int_0^` while the rest is still streaming) fall
 * back to the raw source instead of throwing — the user sees plain text
 * briefly, then the rendered equation once the rest arrives.
 */
function renderKatex(latex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(latex, {
      displayMode,
      throwOnError: false,
      errorColor: "#dc2626",
      output: "html",
      strict: "ignore",
    });
  } catch {
    return `<code>${escapeHtml(latex)}</code>`;
  }
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function MathBlock({ latex }: { latex: string }): ReactNode {
  const html = renderKatex(latex, true);
  return (
    <div
      className="math-block"
      title={`LaTeX: ${latex}`}
      // KaTeX output is server-side-safe HTML; dangerouslySetInnerHTML is the
      // documented way to mount it. The content was produced by KaTeX from
      // the model's literal LaTeX, so the trust boundary is the model.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function MathInline({ latex }: { latex: string }): ReactNode {
  const html = renderKatex(latex, false);
  return (
    <span
      className="math-inline"
      title={`LaTeX: ${latex}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function MathAwareContent({
  content,
  isStreaming,
}: {
  content: string;
  isStreaming: boolean;
}) {
  const segments = splitMathSegments(content);
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === "text") {
          return (
            <Markdown
              key={i}
              display="block"
              isStreaming={isStreaming}
            >
              {seg.text}
            </Markdown>
          );
        }
        if (seg.kind === "math-block") {
          return <MathBlock key={i} latex={seg.text} />;
        }
        return <MathInline key={i} latex={seg.text} />;
      })}
    </>
  );
}
