import type { Chunk, ChunkOptions } from "#learn/chunk/types";
import type { ParsedDocument } from "#learn/parse/types";

import { countTokens } from "#learn/chunk/tokens";

export const DEFAULT_TARGET_TOKENS = 512;
export const DEFAULT_OVERLAP_TOKENS = 64;

/** The smallest piece a chunk boundary can fall between: a heading, a sentence, or a table row. */
interface Unit {
  text: string;
  tokens: number;
  page: number | null;
  section: string | null;
  /** Units from the same block join with a space (sentences) or a newline (rows). */
  block: number;
  heading: boolean;
  /** A table row's header and separator lines, repeated wherever a chunk starts inside the table. */
  table: { header: string; tokens: number } | null;
}

/**
 * Packs a parsed document into chunks of about `targetTokens`. Boundaries fall between sentences and
 * table rows, never inside a word or a row; every heading starts a new chunk, and a section that
 * runs long splits with `overlapTokens` of trailing sentences or rows carried into the next chunk.
 * A chunk exceeds the target only by the unit that wouldn't fit anywhere smaller: one long sentence
 * or one row (plus its table header).
 */
export function chunk(doc: ParsedDocument, options: ChunkOptions = {}): Chunk[] {
  const target = options.targetTokens ?? DEFAULT_TARGET_TOKENS;
  const overlap = options.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;
  if (!(target > 0) || !(overlap >= 0) || overlap >= target) {
    throw new RangeError(`need 0 <= overlapTokens < targetTokens, got ${overlap} and ${target}`);
  }

  const chunks: Chunk[] = [];
  let current: Unit[] = [];
  let tokens = 0;
  let fresh = 0;
  let freshContent = 0;
  const emit = () => {
    if (fresh > 0) chunks.push(build(current, chunks.length));
  };

  for (const unit of units(doc, target)) {
    if (unit.heading && current.some((u) => !u.heading)) {
      emit();
      current = [];
      tokens = fresh = freshContent = 0;
    } else if (!unit.heading && freshContent > 0 && tokens + cost(unit, current.at(-1)) > target) {
      emit();
      current = tail(current, overlap);
      tokens = current.reduce((sum, u, i) => sum + cost(u, current[i - 1]), 0);
      fresh = freshContent = 0;
    }
    tokens += cost(unit, current.at(-1));
    current.push(unit);
    fresh++;
    if (!unit.heading) freshContent++;
  }
  emit();
  return chunks;
}

function units(doc: ParsedDocument, target: number): Unit[] {
  const out: Unit[] = [];
  let section: string | null = null;
  let block = 0;
  const pages = doc.pages ?? [{ number: null, blocks: doc.blocks }];
  for (const page of pages) {
    for (const b of page.blocks) {
      block++;
      const base = { page: page.number, block, heading: false, table: null };
      if (b.kind === "heading") {
        section = b.text;
        const text = `${"#".repeat(b.level)} ${b.text}`;
        out.push({ ...base, section, text, tokens: countTokens(text), heading: true });
      } else if (b.kind === "text") {
        for (const text of pieces(b.text, target)) out.push({ ...base, section, text, tokens: countTokens(text) });
      } else {
        const lines = b.markdown.split("\n");
        const header = lines.slice(0, 2).join("\n");
        const rows = lines.slice(2);
        if (rows.length === 0) {
          out.push({ ...base, section, text: header, tokens: countTokens(header) });
          continue;
        }
        const table = { header, tokens: countTokens(header) };
        for (const row of rows) out.push({ ...base, section, text: row, tokens: countTokens(row), table });
      }
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

/** What `unit` adds to a chunk after `prev`: itself, a separator, and the table header if it opens a table. */
function cost(unit: Unit, prev: Unit | undefined): number {
  return unit.tokens + 1 + (unit.table && prev?.block !== unit.block ? unit.table.tokens : 0);
}

/** The trailing sentences or rows of a chunk, up to `overlap` tokens, to repeat at the start of the next. */
function tail(units: Unit[], overlap: number): Unit[] {
  const out: Unit[] = [];
  let tokens = 0;
  for (let i = units.length - 1; i >= 0 && !units[i].heading; i--) {
    tokens += units[i].tokens + 1;
    if (tokens > overlap) break;
    out.unshift(units[i]);
  }
  return out;
}

function build(units: Unit[], ordinal: number): Chunk {
  let text = "";
  units.forEach((unit, i) => {
    const prev = units[i - 1];
    if (prev && prev.block === unit.block) {
      text += unit.table ? `\n${unit.text}` : ` ${unit.text}`;
    } else {
      text += `${prev ? "\n\n" : ""}${unit.table ? `${unit.table.header}\n` : ""}${unit.text}`;
    }
  });
  const pages = units.map((unit) => unit.page).filter((page) => page !== null);
  return {
    ordinal,
    text,
    pageStart: pages.length ? Math.min(...pages) : null,
    pageEnd: pages.length ? Math.max(...pages) : null,
    section: units.at(-1)!.section,
    tokenCount: countTokens(text),
  };
}
