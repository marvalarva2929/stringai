/**
 * A deliberately small Markdown subset — exactly what the chat coach emits.
 *
 * Claude writes `**bold**`, occasional italics, and short bullet lists in
 * conversational replies. Rendered as plain text those asterisks show up raw,
 * which is what this fixes.
 *
 * Purpose-built rather than a Markdown dependency: the input is one model's
 * chat prose, not arbitrary documents, so headings/tables/links/images/HTML are
 * out of scope — and the chat prompt is written to stay inside this subset. A
 * general renderer would add a transitive tree and image loading to a
 * launch-critical app in exchange for syntax that never appears.
 *
 * Pure and dependency-free so it runs under the Node test harness, matching
 * lib/streak.ts and lib/analyticsUserProps.ts.
 */

export type InlineToken =
  | { type: 'text'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'italic'; text: string }
  | { type: 'boldItalic'; text: string }
  | { type: 'code'; text: string };

export type MarkdownBlock =
  | { type: 'paragraph'; spans: InlineToken[] }
  | { type: 'bullet'; spans: InlineToken[] }
  | { type: 'numbered'; marker: string; spans: InlineToken[] };

// Ordered longest-delimiter-first so `***x***` isn't eaten as `**` + `*`.
// Each alternative requires a closing delimiter, so a lone `*` (a multiplication
// sign, a censored word) is left as literal text rather than swallowing the rest.
const INLINE = /\*\*\*(.+?)\*\*\*|___(.+?)___|\*\*(.+?)\*\*|__(.+?)__|\*(.+?)\*|_(.+?)_|`([^`]+?)`/g;

/** Splits one line into styled spans. Never throws; unmatched syntax stays literal. */
export function parseInline(input: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let lastIndex = 0;

  INLINE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE.exec(input)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', text: input.slice(lastIndex, match.index) });
    }
    const [, boldItalicA, boldItalicB, boldA, boldB, italicA, italicB, code] = match;
    if (boldItalicA ?? boldItalicB) {
      tokens.push({ type: 'boldItalic', text: (boldItalicA ?? boldItalicB)! });
    } else if (boldA ?? boldB) {
      tokens.push({ type: 'bold', text: (boldA ?? boldB)! });
    } else if (italicA ?? italicB) {
      tokens.push({ type: 'italic', text: (italicA ?? italicB)! });
    } else if (code) {
      tokens.push({ type: 'code', text: code });
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < input.length) {
    tokens.push({ type: 'text', text: input.slice(lastIndex) });
  }
  // An empty line still needs one span so callers can render a blank paragraph.
  return tokens.length > 0 ? tokens : [{ type: 'text', text: '' }];
}

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;
// Headings never appear in a 2-5 sentence reply, but if one does, showing "###"
// is worse than showing a bold line.
const HEADING = /^\s*#{1,6}\s+(.*)$/;

/**
 * Splits text into blocks. Consecutive plain lines join into one paragraph —
 * models hard-wrap prose, and preserving those breaks would make bubbles ragged.
 */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length === 0) return;
    blocks.push({ type: 'paragraph', spans: parseInline(paragraph.join(' ')) });
    paragraph = [];
  };

  for (const rawLine of (source ?? '').split('\n')) {
    const line = rawLine.trimEnd();

    if (line.trim() === '') {
      flush();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: 'paragraph', spans: [{ type: 'bold', text: heading[1].trim() }] });
      continue;
    }

    const numbered = NUMBERED.exec(line);
    if (numbered) {
      flush();
      blocks.push({ type: 'numbered', marker: `${numbered[1]}.`, spans: parseInline(numbered[2]) });
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      flush();
      blocks.push({ type: 'bullet', spans: parseInline(bullet[1]) });
      continue;
    }

    paragraph.push(line.trim());
  }

  flush();
  return blocks;
}

/** The text with all markup removed — for analytics and accessibility labels. */
export function stripMarkdown(source: string): string {
  return parseMarkdown(source)
    .map((b) => b.spans.map((s) => s.text).join(''))
    .join('\n')
    .trim();
}
