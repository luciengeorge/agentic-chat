import type { Chunk, ChunkOptions } from "#learn/chunk/types";
import type { ParsedDocument } from "#learn/parse/types";

import { countTokens } from "#learn/chunk/tokens";

export const DEFAULT_TARGET_TOKENS = 512;

/** The smallest piece a chunk boundary can fall between: a sentence, for now. */
export interface Unit {
  text: string;
  tokens: number;
  page: number | null;
  /** Units from the same block join with a space; different blocks with a blank line. */
  block: number;
}

/** Packs a parsed document into chunks of at most `targetTokens`, cutting only between sentences. */
export function chunk(doc: ParsedDocument, options: ChunkOptions = {}): Chunk[] {
  const target = options.targetTokens ?? DEFAULT_TARGET_TOKENS;
  if (!(target > 0)) throw new RangeError(`need targetTokens > 0, got ${target}`);
  return pack(units(doc, target), target).map(build);
}

/** Packs units into windows of at most `target` tokens. A window closes when the next unit wouldn't fit. */
export function pack(units: Unit[], target: number): Unit[][] {
  const windows: Unit[][] = [];
  let current: Unit[] = [];
  let tokens = 0;
  for (const unit of units) {
    if (current.length > 0 && tokens + cost(unit) > target) {
      windows.push(current);
      current = [];
      tokens = 0;
    }
    tokens += cost(unit);
    current.push(unit);
  }
  if (current.length > 0) windows.push(current);
  return windows;
}

/** Every block as units: a heading is one line, a text block its sentences. A table is text, for now. */
function units(doc: ParsedDocument, target: number): Unit[] {
  const out: Unit[] = [];
  let block = 0;
  const pages = doc.pages ?? [{ number: null, blocks: doc.blocks }];
  for (const page of pages) {
    for (const b of page.blocks) {
      block++;
      const texts =
        b.kind === "heading"
          ? [`${"#".repeat(b.level)} ${b.text}`]
          : pieces(b.kind === "text" ? b.text : b.markdown, target);
      for (const text of texts) out.push({ text, tokens: countTokens(text), page: page.number, block });
    }
  }
  return out;
}

/** A text block's sentences; a sentence longer than `target` splits between words. */
function pieces(text: string, target: number): string[] {
  const out: string[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+(?=["'(£€$A-Z0-9])/)) {
    if (countTokens(sentence) <= target) {
      out.push(sentence);
      continue;
    }
    let piece = "";
    let pieceTokens = 0;
    for (const word of sentence.split(/\s+/)) {
      const wordTokens = countTokens(` ${word}`);
      if (piece && pieceTokens + wordTokens > target) {
        out.push(piece);
        piece = "";
        pieceTokens = 0;
      }
      piece = piece ? `${piece} ${word}` : word;
      pieceTokens += wordTokens;
    }
    if (piece) out.push(piece);
  }
  return out.filter((piece) => piece.trim() !== "");
}

/** What `unit` adds to a chunk: its own tokens, plus 1 for the space or blank line that joins it on. */
export function cost(unit: Unit): number {
  return unit.tokens + 1;
}

function build(units: Unit[], ordinal: number): Chunk {
  let text = "";
  units.forEach((unit, i) => {
    const prev = units[i - 1];
    text += prev ? `${prev.block === unit.block ? " " : "\n\n"}${unit.text}` : unit.text;
  });
  const pages = units.map((unit) => unit.page).filter((page) => page !== null);
  return {
    ordinal,
    text,
    pageStart: pages.length ? Math.min(...pages) : null,
    pageEnd: pages.length ? Math.max(...pages) : null,
    section: null,
    tokenCount: countTokens(text),
  };
}
