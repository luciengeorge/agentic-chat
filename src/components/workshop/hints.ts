/** The hint legend, as the course's front door (`exercises/README.md`) gives it. */
export const HINT_LEGEND = [
  { emoji: "👨‍💼", label: "Why", meaning: "Why Kestrel needs this" },
  { emoji: "🐨", label: "Do", meaning: "Do this, one block of work at a time" },
  {
    emoji: "💰",
    label: "Tip",
    meaning: "A code tip: a function's name, an import, some syntax. Never the answer itself",
  },
  { emoji: "🦉", label: "Mechanism", meaning: "Why it works this way: the mechanism. Read these; they're the lesson" },
  { emoji: "📜", label: "Docs", meaning: "Docs worth reading" },
  { emoji: "🚨", label: "Tests", meaning: "What the tests check, and the mistake people make most" },
  { emoji: "💯", label: "Extra", meaning: "Extra credit, not tested" },
] as const;

export type HintEmoji = (typeof HINT_LEGEND)[number]["emoji"];

export type Hint = { emoji: HintEmoji; text: string; file: string; line: number };

const EMOJIS = HINT_LEGEND.map((hint) => hint.emoji);
const COMMENT = /^\s*\/\/ ?(.*)$/;

/** The emoji a line of text opens with, if it's a hint's. */
export function hintEmoji(text: string): HintEmoji | null {
  return EMOJIS.find((emoji) => text.startsWith(emoji)) ?? null;
}

/**
 * The hints in a problem file, in file order. A hint is a `//` comment that opens with one of the legend's emoji;
 * the indented comment lines under it continue it, and a blank comment, a new hint or code ends it.
 */
export function parseHints(file: string, source: string): Hint[] {
  const hints: Hint[] = [];
  let open: Hint | null = null;
  source.split("\n").forEach((raw, index) => {
    const comment = COMMENT.exec(raw)?.[1];
    if (comment === undefined) {
      open = null;
      return;
    }
    const emoji = hintEmoji(comment);
    if (emoji) {
      open = { emoji, text: comment.slice(emoji.length).trim(), file, line: index + 1 };
      hints.push(open);
    } else if (open && /^\s+\S/.test(comment)) {
      open.text += ` ${comment.trim()}`;
    } else {
      open = null;
    }
  });
  return hints;
}
