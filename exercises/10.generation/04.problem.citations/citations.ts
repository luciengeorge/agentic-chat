// 👨‍💼 Every claim in a Kestrel answer carries a citation, and the chat turns each one into a chip that opens the
//    page. Grace Adeyemi will click "S1" and expect to see the words it quotes, on the invoice it names. A
//    citation the source doesn't back is worse than none: it makes a guess look checked.
//
// 🦉 New in this file: `parseCitations` (finds the `[[S1: "..."]]` markers), `normalizeForMatch` (what "the same
//    text" means) and `ELLIPSIS`.

/**
 * Citations look like `[[S1: "a span copied from source S1"]]`. The validator keeps one only when its label names
 * a source the model was given and its quote is in that source's text. Everything else is dropped, and the answer
 * is flagged.
 */

/** A retrieved chunk as the prompt labelled it. */
export interface CitableSource {
  label: string;
  chunkId: string;
  documentId: string;
  title: string;
  path: string;
  pageStart: number | null;
  pageEnd: number | null;
  text: string;
}

export interface ParsedCitation {
  /** The marker as it appears in the answer. */
  marker: string;
  label: string;
  quote: string | null;
  index: number;
}

export interface Citation {
  marker: string;
  label: string;
  quote: string;
  chunkId: string;
  documentId: string;
  title: string;
  path: string;
  /** The page to open: the chunk's first page, null for md and docx. */
  page: number | null;
}

export type DropReason = "unknown-source" | "no-quote" | "quote-too-short" | "quote-not-found" | "malformed";

export interface DroppedCitation {
  marker: string;
  label: string | null;
  reason: DropReason;
}

export interface CitationReport {
  citations: Citation[];
  dropped: DroppedCitation[];
  /** Something was dropped, or nothing was cited. */
  flagged: boolean;
}

/** Shorter than this, a quote ("£45", "yes") could match almost any chunk, so it proves nothing. */
export const MIN_QUOTE_CHARS = 8;

const MARKER = /\[\[(.+?)\]\]/gs;
const BODY = /^\s*(S\d+)\s*(?::\s*["“](.+)["”])?\s*$/s;
export const ELLIPSIS = /\s*(?:\.\.\.|…)\s*/;

export function parseCitations(text: string): ParsedCitation[] {
  return [...text.matchAll(MARKER)].map((match) => {
    const body = BODY.exec(match[1]);
    return {
      marker: match[0],
      label: body?.[1] ?? "",
      quote: body?.[2]?.trim() ?? null,
      index: match.index,
    };
  });
}

/** What "the quote appears in the chunk" compares: case, markdown emphasis, table pipes, quote styles and
 * whitespace don't count. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/[*_`|#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Each piece of an elided quote must appear, in order. */
export function quoteInText(quote: string, text: string): boolean {
  // 🐨 Normalise the text once. Split the quote on the ellipsis into pieces, normalise each, and drop empty ones.
  // 🐨 Look for each piece in the normalised text, starting where the last piece ended. A piece that isn't there
  //    means false; every piece found, in order, means true.
  //
  // 💰 `quote.split(ELLIPSIS)`; `haystack.indexOf(piece, from)` is -1 when it's missing.
  //
  // 🦉 Why normalise both sides. The model copies what it read, and it read markdown: `| Hotel, London | £200 a
  //    night |`, `**£45**`. It quotes "Hotel, London £200 a night" or "£45 per day". Taking out case, emphasis,
  //    pipes, curly quotes and runs of spaces on both sides compares the words, not the typesetting.
  // 🦉 Why in order. An elided quote, "Meals while travelling … £45 per day", claims the first words come before
  //    the last. Found in either order, two pieces from different sentences could stitch a claim the source never
  //    makes.
  throw new Error(`quoteInText(${quote.length} characters, ${text.length} characters) isn't written yet`);
}

export function validateCitations(text: string, sources: CitableSource[]): CitationReport {
  // 🐨 Look sources up by label. For each citation `parseCitations` finds, drop it with the first reason that
  //    applies, in this order: no label (`malformed`); a label no source has (`unknown-source`); no quote
  //    (`no-quote`); a quote under `MIN_QUOTE_CHARS` once normalised, ellipses counted as a space
  //    (`quote-too-short`); a quote that isn't in that source's text (`quote-not-found`). Otherwise keep it as a
  //    `Citation`, with the source's chunk id, document id, title, path, and its first page as `page`.
  // 🐨 Flag the report when anything was dropped, or when nothing was kept.
  // 🐨 The classic mistake: checking the quote's length before normalising it. `**£45**` is 7 characters raw and
  //    3 once the stars go. Measure what you'd match.
  //
  // 💰 `new Map(sources.map((s) => [s.label, s]))`. A dropped citation is `{ marker, label: parsed.label || null,
  //    reason }`.
  //
  // 🦉 Why the quote must be in *that* source. The label is what the browser opens: a chip on S2 shows S2's page.
  //    A quote that's really in S5 is a true sentence pinned to the wrong page, and Grace would check the wrong
  //    invoice. Matching against all sources would pass it.
  // 🦉 Why 8 characters. A quote is proof that the claim came from the source. "£45" or "yes" is in half the
  //    corpus, so finding it proves nothing; "£45 a day" (9 once normalised) is a phrase. Too-short quotes are
  //    dropped, so a model can't cite its way past the check with a number.
  // 🦉 Why a reply that cites nothing is flagged. The rule is "cite every claim". An answer with no citations at
  //    all is unchecked prose; the abstention is the one exception, and `answer()` already unflags it.
  //
  // 🚨 The tests check every drop reason, the 8-character rule after normalising, matching through markdown and
  //    pipes, elided quotes in order, a quote checked against its own source only, the flag, and Grace's three
  //    recorded citations: two kept, one dropped.
  throw new Error(`validateCitations(${text.length} characters, ${sources.length} sources) isn't written yet`);
}
