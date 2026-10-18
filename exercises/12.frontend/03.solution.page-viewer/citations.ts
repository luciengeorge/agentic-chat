import type { SourceRef, Verdict } from "@/components/chat/types";

import { parseCitations, type Citation } from "#learn/cite/citations";

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
  const valid = new Map(verdict?.citations.map((c) => [c.marker, c]));
  const byLabel = new Map(sources.map((s) => [s.label, s]));
  const numbers = new Map<string, number>();
  const resolved = new Map<string, Resolved>();

  for (const { marker, label } of parseCitations(text)) {
    if (resolved.has(marker)) continue;
    const citation = valid.get(marker);
    const source = byLabel.get(label);
    const shown = verdict ? citation : source;
    if (!shown) {
      resolved.set(marker, { state: "hidden" });
      continue;
    }
    if (!numbers.has(label)) numbers.set(label, numbers.size + 1);
    const n = numbers.get(label)!;
    resolved.set(marker, citation ? { state: "valid", n, citation } : { state: "pending", n, source: source! });
  }

  const cited = [...resolved.values()].flatMap((r) => (r.state === "valid" ? [{ n: r.n, citation: r.citation }] : []));
  const documents = new Map<string, { n: number; citation: Citation }>();
  for (const entry of cited) if (!documents.has(entry.citation.chunkId)) documents.set(entry.citation.chunkId, entry);

  return { resolved, cited: [...documents.values()].sort((a, b) => a.n - b.n) };
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
  return `/api/chat/documents/${source.documentId}${source.page ? `#page=${source.page}` : ""}`;
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
