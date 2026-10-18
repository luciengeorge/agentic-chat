import type { Chunk, ChunkOptions } from "#learn/chunk/types";
import type { ParsedDocument } from "#learn/parse/types";

import { countTokens } from "#learn/chunk/tokens";

export const DEFAULT_TARGET_TOKENS = 512;
export const DEFAULT_OVERLAP_TOKENS = 64;

/** A table's header and separator lines, repeated wherever a chunk starts inside the table. */
export interface TableHeader {
  header: string;
  tokens: number;
}

/** The smallest piece a chunk boundary can fall between: a heading, a sentence, or a table row. */
export interface Unit {
  text: string;
  tokens: number;
  page: number | null;
  /** The nearest heading above the unit. */
  section: string | null;
  /** Units from the same block join with a space (sentences) or a newline (rows). */
  block: number;
  heading: boolean;
  table: TableHeader | null;
}

/**
 * Packs a parsed document into chunks of about `targetTokens`. Boundaries fall between sentences and
 * table rows, never inside a word or a row; every heading starts a new chunk, and a section that
 * runs long splits with `overlapTokens` of trailing sentences or rows carried into the next chunk.
 * A chunk exceeds the target only by the unit that wouldn't fit anywhere smaller: one long sentence
 * or one row (plus its table header).
 *
 * Section 04 of the course builds it in four functions: `pack` (sizing), `tail` (overlap),
 * `sections` (headings) and `tableRows` (tables).
 */
export function chunk(doc: ParsedDocument, options: ChunkOptions = {}): Chunk[] {
  const target = options.targetTokens ?? DEFAULT_TARGET_TOKENS;
  const overlap = options.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;
  if (!(target > 0) || !(overlap >= 0) || overlap >= target) {
    throw new RangeError(`need 0 <= overlapTokens < targetTokens, got ${overlap} and ${target}`);
  }

  const chunks: Chunk[] = [];
  for (const section of sections(units(doc, target))) {
    for (const window of pack(section, target, overlap)) chunks.push(build(window, chunks.length));
  }
  return chunks;
}

/**
 * Packs one section's units into windows of at most `target` tokens. A window closes when the next
 * unit wouldn't fit, and the next window starts with `tail` of it. A heading never closes a window,
 * so it stays with the text it introduces.
 */
export function pack(units: Unit[], target: number, overlap: number): Unit[][] {
  const windows: Unit[][] = [];
  let current: Unit[] = [];
  let tokens = 0;
  /** Text units in `current` that aren't overlap: a window only closes once it has one. */
  let added = 0;
  for (const unit of units) {
    if (!unit.heading && added > 0 && tokens + cost(unit, current.at(-1)) > target) {
      windows.push(current);
      current = tail(current, overlap);
      tokens = current.reduce((sum, u, i) => sum + cost(u, current[i - 1]), 0);
      added = 0;
    }
    tokens += cost(unit, current.at(-1));
    current.push(unit);
    if (!unit.heading) added++;
  }
  if (current.length > 0) windows.push(current);
  return windows;
}

/** The trailing sentences or rows of a window, up to `overlap` tokens, to repeat at the start of the next. */
export function tail(units: Unit[], overlap: number): Unit[] {
  const out: Unit[] = [];
  let tokens = 0;
  for (let i = units.length - 1; i >= 0 && !units[i].heading; i--) {
    tokens += units[i].tokens + 1;
    if (tokens > overlap) break;
    out.unshift(units[i]);
  }
  return out;
}

/**
 * Splits the units into sections, each packed on its own. A heading starts a new section, unless the
 * section so far holds only headings: `# Runbook` then `## 1. Pipeline` open one section together.
 */
export function sections(units: Unit[]): Unit[][] {
  const out: Unit[][] = [];
  for (const unit of units) {
    const last = out.at(-1);
    if (last && !(unit.heading && last.some((u) => !u.heading))) last.push(unit);
    else out.push([unit]);
  }
  return out;
}

/** A markdown table's rows, each carrying its header. A table with no rows is its header alone. */
export function tableRows(markdown: string): Pick<Unit, "text" | "tokens" | "table">[] {
  const lines = markdown.split("\n");
  const header = lines.slice(0, 2).join("\n");
  const rows = lines.slice(2);
  if (rows.length === 0) return [{ text: header, tokens: countTokens(header), table: null }];
  const table = { header, tokens: countTokens(header) };
  return rows.map((row) => ({ text: row, tokens: countTokens(row), table }));
}

/** Every block as units: a heading is one line, a text block its sentences, a table its rows. */
function units(doc: ParsedDocument, target: number): Unit[] {
  const out: Unit[] = [];
  let section: string | null = null;
  let block = 0;
  const pages = doc.pages ?? [{ number: null, blocks: doc.blocks }];
  for (const page of pages) {
    for (const b of page.blocks) {
      block++;
      if (b.kind === "heading") section = b.text;
      const base = { page: page.number, block, section, heading: false, table: null };
      if (b.kind === "heading") {
        const text = `${"#".repeat(b.level)} ${b.text}`;
        out.push({ ...base, text, tokens: countTokens(text), heading: true });
      } else if (b.kind === "text") {
        for (const text of pieces(b.text, target)) out.push({ ...base, text, tokens: countTokens(text) });
      } else {
        for (const row of tableRows(b.markdown)) out.push({ ...base, ...row });
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
export function cost(unit: Unit, prev: Unit | undefined): number {
  return unit.tokens + 1 + (unit.table && prev?.block !== unit.block ? unit.table.tokens : 0);
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
