// 👨‍💼 Kestrel's assistant can't search a 3,000-page filing as one piece. Ingestion cuts every document into
//    chunks, short pieces that each get their own place in the search index, and this file decides where
//    the cuts go. A chunk that's too big blurs many topics into one search result; too small, and it loses
//    the sentence around a fact.

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
  // 🐨 Walk the units in order. Keep the window you're filling (a list of units) and a running total of
  //    what it costs so far.
  // 🐨 Before you add a unit, ask whether it fits: would the total plus this unit go over `target`? If it
  //    would, and the window already holds something, close the window (put it on the list you return)
  //    and start an empty one. Then add the unit and its cost.
  // 🐨 After the loop, close the last window if it holds anything.
  //
  // 💰 cost(unit) is what a unit adds to a window. `current.length > 0` says whether a window holds anything.
  //
  // 🦉 Why tokens, not characters. The embedding model and the chat model both read tokens, the pieces a
  //    tokenizer cuts text into, and both count their limits in tokens. Characters don't map evenly onto
  //    tokens: "Tom Whitfield" is 13 characters and 3 tokens, "KPC-2026-0142" is 13 characters and 8. A
  //    cut every 2,000 characters would give a chunk of contract numbers nearly three times the tokens of
  //    a chunk of names. Counting tokens keeps every chunk the same size to the model.
  // 🦉 Why a unit costs its tokens plus 1. Units are joined with a space or a blank line, and a blank line
  //    is a token of its own. Adding 1 for every join keeps your total at or a little above the real count
  //    of the finished text: on page 2 of the Ashgrove MSA your total reaches 509 where countTokens says
  //    494. Erring high is what lets you promise "never over the target".
  // 🦉 Why "already holds something". pieces() lets a sentence be as big as the target on its own. If the
  //    very first unit doesn't fit, closing the empty window would make an empty chunk; the unit has to go
  //    in anyway, as a chunk of its own.
  //
  // 📜 https://github.com/niieani/gpt-tokenizer (the tokenizer behind countTokens)
  // 📜 https://platform.openai.com/tokenizer (paste a contract number and watch it split)
  //
  // 🚨 The tests check that no chunk goes over the target, that a chunk closes only when the next
  //    sentence wouldn't fit, that every sentence lands whole and in order, that contract numbers fill a
  //    chunk in fewer characters than names do, and that page 2 of the Ashgrove MSA splits at 494 tokens.
  throw new Error(`pack(${units.length} units, target ${target}) isn't written yet`);
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
