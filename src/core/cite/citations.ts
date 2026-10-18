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
  const haystack = normalizeForMatch(text);
  let from = 0;
  for (const piece of quote.split(ELLIPSIS).map(normalizeForMatch).filter(Boolean)) {
    const at = haystack.indexOf(piece, from);
    if (at === -1) return false;
    from = at + piece.length;
  }
  return true;
}

export function validateCitations(text: string, sources: CitableSource[]): CitationReport {
  const byLabel = new Map(sources.map((s) => [s.label, s]));
  const citations: Citation[] = [];
  const dropped: DroppedCitation[] = [];

  for (const parsed of parseCitations(text)) {
    const drop = (reason: DropReason) => dropped.push({ marker: parsed.marker, label: parsed.label || null, reason });
    if (!parsed.label) {
      drop("malformed");
      continue;
    }
    const source = byLabel.get(parsed.label);
    if (!source) drop("unknown-source");
    else if (parsed.quote === null) drop("no-quote");
    else if (normalizeForMatch(parsed.quote.replace(ELLIPSIS, " ")).length < MIN_QUOTE_CHARS) drop("quote-too-short");
    else if (!quoteInText(parsed.quote, source.text)) drop("quote-not-found");
    else {
      citations.push({
        marker: parsed.marker,
        label: parsed.label,
        quote: parsed.quote,
        chunkId: source.chunkId,
        documentId: source.documentId,
        title: source.title,
        path: source.path,
        page: source.pageStart,
      });
    }
  }

  return { citations, dropped, flagged: dropped.length > 0 || citations.length === 0 };
}
