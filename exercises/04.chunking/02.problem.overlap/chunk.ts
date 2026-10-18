// 👨‍💼 A cut between two sentences can split a fact in half: the clause that says who may terminate lands in one
//    chunk, the fee they pay in the next, and search finds neither half useful. Overlap repeats the end of
//    each chunk at the start of the next, so the two halves meet again.

import type { Chunk, ChunkOptions } from "#learn/chunk/types";
import type { ParsedDocument } from "#learn/parse/types";

import { countTokens } from "#learn/chunk/tokens";

export const DEFAULT_TARGET_TOKENS = 512;
export const DEFAULT_OVERLAP_TOKENS = 64;

/** The smallest piece a chunk boundary can fall between: a sentence, for now. */
export interface Unit {
  text: string;
  tokens: number;
  page: number | null;
  /** Units from the same block join with a space; different blocks with a blank line. */
  block: number;
}

/**
 * Packs a parsed document into chunks of at most `targetTokens`, cutting only between sentences, with
 * `overlapTokens` of trailing sentences carried into the next chunk.
 */
export function chunk(doc: ParsedDocument, options: ChunkOptions = {}): Chunk[] {
  const target = options.targetTokens ?? DEFAULT_TARGET_TOKENS;
  const overlap = options.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;
  if (!(target > 0) || !(overlap >= 0) || overlap >= target) {
    throw new RangeError(`need 0 <= overlapTokens < targetTokens, got ${overlap} and ${target}`);
  }
  return pack(units(doc, target), target, overlap).map(build);
}

/**
 * Packs units into windows of at most `target` tokens. A window closes when the next unit wouldn't fit,
 * and the next window starts with `tail` of it.
 */
export function pack(units: Unit[], target: number, overlap: number): Unit[][] {
  const windows: Unit[][] = [];
  let current: Unit[] = [];
  let tokens = 0;
  /** Units in `current` that aren't overlap: a window only closes once it has one. */
  let added = 0;
  for (const unit of units) {
    if (added > 0 && tokens + cost(unit) > target) {
      windows.push(current);
      current = tail(current, overlap);
      tokens = current.reduce((sum, u) => sum + cost(u), 0);
      added = 0;
    }
    tokens += cost(unit);
    current.push(unit);
    added++;
  }
  if (current.length > 0) windows.push(current);
  return windows;
}

/** The trailing sentences of a window, up to `overlap` tokens, to repeat at the start of the next. */
export function tail(units: Unit[], overlap: number): Unit[] {
  // 🐨 Walk the window backwards, from its last unit, adding up what each unit costs (its tokens plus 1).
  // 🐨 Stop at the first unit that would take the total over `overlap`. Return the units you passed, in
  //    the order they appear in the window.
  //
  // 💰 `for (let i = units.length - 1; i >= 0; i--)` walks backwards. `out.unshift(unit)` puts a unit at
  //    the front of a list.
  //
  // 🦉 Why overlap at all. Search scores each chunk on its own, and a sentence often leans on the one
  //    before it: "It must then pay an early termination fee equal to 50% of the platform fees" says
  //    nothing about who pays, or why, without the sentence ahead of it. If a cut falls between the two,
  //    each chunk holds half a fact. Repeating the end of one chunk at the start of the next puts every
  //    sentence beside its neighbour in at least one chunk, so the fact is whole somewhere.
  // 🦉 Why from the end. The sentence that needs help is the first one of the next chunk, and the help it
  //    needs is what came just before it.
  // 🦉 Why whole sentences, even when that leaves some of the budget unused. Half a sentence is noise to
  //    the embedding, and half a contract number ("KPC-2026-" in one chunk, "0142" in the next) can't be
  //    found by anyone. So stop at the first unit that doesn't fit; never cut one to fill the gap.
  // 🦉 What it costs. The repeated tokens are stored, embedded and searched twice: 64 of 512 makes the
  //    index about an eighth bigger.
  //
  // 📜 https://www.pinecone.io/learn/chunking-strategies/
  //
  // 🚨 The tests check that each chunk starts with the last whole sentences of the one before, as many as
  //    fit in overlapTokens and no more; that nothing repeats when the last sentence alone is too big or
  //    overlapTokens is 0; that every pair of neighbouring sentences ends up together in some chunk; and
  //    that page 2 of the Ashgrove MSA, at a target of 384, carries clause 10.1 into the second chunk.
  throw new Error(`tail(${units.length} units, overlap ${overlap}) isn't written yet`);
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
