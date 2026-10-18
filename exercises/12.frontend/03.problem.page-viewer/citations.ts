// 👨‍💼 Every claim in a Kestrel answer carries a numbered chip, and the chip opens the passage it came from and,
//    one click on, the document at its page. People check claims only when that's quick and always right. This
//    file decides which chip each citation marker becomes, and where the "open the document" link goes.

import type { Citation } from "#learn/cite/citations";
import type { SourceRef, Verdict } from "@/components/chat/types";

// 🦉 New in this file: collapseRuns (side-by-side markers with the same number become one chip), toOpenSource and
//    quotePattern (what the source panel marks) are written. src/components/chat/messages.tsx calls
//    resolveCitations and collapseRuns on each reply; src/components/chat/source-sheet.tsx calls documentHref.

/** What a citation chip opens: one chunk of one document, at a page. */
export interface OpenSource {
  label: string;
  chunkId: string;
  documentId: string;
  title: string;
  path: string;
  page: number | null;
  quote: string | null;
}

export type Resolved =
  | { state: "valid"; n: number; citation: Citation }
  | { state: "pending"; n: number; source: SourceRef }
  | { state: "hidden" };

/**
 * How each citation marker in a reply shows. Once the verdict is in, a marker is a numbered chip if the validator
 * kept it, and disappears if it dropped it. While the reply streams, a marker whose label names a source shows as a
 * pending chip. Numbers follow first appearance, one per label.
 */
export function resolveCitations(
  text: string,
  sources: SourceRef[],
  verdict: Verdict | undefined,
): { resolved: Map<string, Resolved>; cited: { n: number; citation: Citation }[] } {
  // 🐨 Read the markers in `text` in order with parseCitations: each has its `marker` (the exact text) and
  //    `label` ("S5"). A marker that appears twice, word for word, is decided once: skip the repeats.
  // 🐨 Decide what each marker shows:
  //    - once the verdict is in: "valid" if the validator kept it (find it in verdict.citations by its marker),
  //      "hidden" if not;
  //    - before the verdict: "pending" if its label names one of `sources`, "hidden" if not.
  // 🐨 Number by label, in the order the labels first appear: the first label shown is 1, the next new one 2, and
  //    a label seen before keeps its number. Hidden markers take no number.
  // 🐨 Return `resolved` (marker -> what it shows) and `cited`: the valid ones, one per chunk (the first marker
  //    of each), sorted by number. The page lists them under the answer as "Sources".
  //
  // 💰 import { parseCitations } from "#learn/cite/citations";
  // 💰 new Map(verdict?.citations.map((c) => [c.marker, c])); new Map(sources.map((s) => [s.label, s]))
  // 💰 A Map's `size` is the next number: numbers.set(label, numbers.size + 1)
  //
  // 🦉 Why by label and not by marker. The model quotes the same source as often as it needs, once per claim:
  //    Leo's answer quotes S8 twice, for two different sentences. To a reader that's one document, so it's one
  //    number; two numbers would look like two sources agreeing.
  // 🦉 Why in order of first appearance and not the label's own number. Labels are the prompt's order, S1 to S8,
  //    which is search's ranking. The reader never saw the prompt. Chips that read 5, 8, 4, 2 look like a
  //    mistake; 1, 2, 3, 4 read as "the first source, the second...".
  // 🦉 Why the verdict decides. A marker in the text is only the model's claim. The validator checked the quote
  //    against the chunk; one it dropped points at nothing real, so it shows nothing, even though its label
  //    names a source. Before the verdict, a label that names a source is shown as pending (grey, not
  //    clickable), so chips don't pop in all at once at the end.
  //
  // 🚨 The tests check the numbers, that dropped and unknown markers show nothing, that a streaming reply shows
  //    pending chips, and Leo's six markers.
  throw new Error(
    `resolveCitations(${text.length} characters, ${sources.length} sources, ${verdict ? "a" : "no"} verdict) isn't written yet`,
  );
}

const RUN = /\[\[(?:(?!\]\]).)+\]\](?:\s*\[\[(?:(?!\]\]).)+\]\])+/gs;
const ONE = /\[\[(?:(?!\]\]).)+\]\]/gs;

/** Markers side by side that show the same number ("2 2") become one chip. */
export function collapseRuns(text: string, resolved: Map<string, Resolved>): string {
  return text.replace(RUN, (run) => {
    const seen = new Set<number>();
    return [...run.matchAll(ONE)]
      .map(([marker]) => {
        const entry = resolved.get(marker);
        if (!entry || entry.state === "hidden" || seen.has(entry.n)) return "";
        seen.add(entry.n);
        return marker;
      })
      .join("");
  });
}

export const toOpenSource = (citation: Citation): OpenSource => ({
  label: citation.label,
  chunkId: citation.chunkId,
  documentId: citation.documentId,
  title: citation.title,
  path: citation.path,
  page: citation.page,
  quote: citation.quote,
});

/** The link that opens the original document at the cited page. A PDF viewer reads the page from `#page=N`. */
export function documentHref(source: OpenSource): string {
  // 🐨 The document's URL is /api/chat/documents/<documentId>. When the source has a page, add #page=<page> to
  //    it. A document without pages (markdown, Word) has `page: null`: its link has no fragment at all.
  //
  // 🦉 Why a fragment, `#page=2`, and not a query, `?page=2`. The part after `#` stays in the browser: it's never
  //    sent to the server. The server sends the whole PDF either way, and the browser's PDF viewer reads
  //    `#page=2` and opens there. A `?page=2` goes to the server, which ignores it, and the viewer opens at
  //    page 1. It also makes every page a different URL for the same file.
  // 🦉 Why page 2 for a chunk on pages 2 and 3. A citation's `page` is the chunk's first page (pageStart), where
  //    the quoted passage begins.
  //
  // 📜 https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Fragment
  // 📜 https://datatracker.ietf.org/doc/html/rfc8118#section-3 (the PDF `#page=` fragment)
  //
  // 🚨 The tests check the link for a page and for a document without one.
  throw new Error(`documentHref(${source.documentId}, page ${source.page}) isn't written yet`);
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A pattern for the quote's pieces (an elided quote, "a … b", has two), each matching across runs of
 * whitespace. Pipes and markdown between words won't match once the chunk is rendered, so a quote that spans
 * two table cells marks nothing; the chip's tooltip still shows it. */
export function quotePattern(quote: string | null): RegExp | undefined {
  if (!quote) return undefined;
  const pieces = quote
    .replace(/[*_`]/g, "")
    .split(/\s*(?:\.\.\.|…)\s*/)
    .map((piece) => piece.split(/\s+/).filter(Boolean).map(escape).join("\\s+"))
    .filter(Boolean);
  return pieces.length ? new RegExp(`(${pieces.join("|")})`, "gi") : undefined;
}
