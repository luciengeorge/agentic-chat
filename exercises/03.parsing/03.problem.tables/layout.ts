// 👨‍💼 Kestrel's documents are full of tables: error codes, prices, the P&L. A PDF doesn't store a table, only
//    pieces of text at positions. Read them line by line and a wrapped cell becomes a row of its own, and a value
//    lands under the wrong heading. This file rebuilds the rows and columns, so a table reaches search as markdown.

import type { Block } from "#learn/parse/types";

import { tableBlock } from "#learn/parse/tables";

/** One run of text from a PDF's text layer. `x` and `y` are the baseline start, in points from the bottom left. */
export interface PositionedText {
  str: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
}

/** A run of text on one line, with where it starts and ends (points from the left). */
export interface Segment {
  x0: number;
  x1: number;
  text: string;
}

/** One line of the page: its baseline, its font size and its segments, left to right. */
export interface Line {
  y: number;
  fontSize: number;
  segments: Segment[];
}

/** Runs further apart than this (in points) are separate cells; word spaces are about 3. Table gutters are 8 or more. */
const CELL_GAP = 5;
/** Text this size or larger is a heading; body text is 10pt and tables 7 to 9pt. */
const HEADING_SIZES = [
  { min: 16, level: 1 },
  { min: 13, level: 2 },
  { min: 11.5, level: 3 },
];
/** The bottom margin, as a share of the page height, holds the running footer ("Page 2 of 7"). */
const FOOTER_SHARE = 0.06;

/**
 * Turns one page's text layer into blocks: headings by font size, paragraphs and bullets by
 * position, and tables where lines split into aligned cells.
 */
export function layoutPage(items: PositionedText[], pageHeight: number): Block[] {
  const lines = toLines(items.filter((item) => item.str.trim() !== "" && item.y > pageHeight * FOOTER_SHARE));
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const level = headingLevel(line.fontSize);
    if (level !== null) {
      const parts = [lineText(line)];
      while (i + 1 < lines.length && lines[i + 1].fontSize === line.fontSize && follows(lines[i], lines[i + 1], 1.5)) {
        parts.push(lineText(lines[++i]));
      }
      blocks.push({ kind: "heading", level, text: parts.join(" ") });
      i++;
      continue;
    }
    if (isBullet(line)) {
      const textX = line.segments[0].text === "•" ? (line.segments[1]?.x0 ?? 0) : line.segments[0].x0;
      const parts = [lineText(line).replace(/^•\s*/, "")];
      while (i + 1 < lines.length && continuesAt(lines[i], lines[i + 1], textX)) parts.push(lineText(lines[++i]));
      blocks.push({ kind: "text", text: `- ${joinWords(parts)}` });
      i++;
      continue;
    }
    const tableEnd = line.segments.length > 1 ? tableExtent(lines, i) : i;
    if (tableEnd > i) {
      blocks.push(tableBlock(tableRows(lines.slice(i, tableEnd + 1))));
      i = tableEnd + 1;
      continue;
    }
    const parts = [lineText(line)];
    const x = line.segments[0].x0;
    while (i + 1 < lines.length && continuesAt(lines[i], lines[i + 1], x) && lines[i + 1].segments.length === 1) {
      parts.push(lineText(lines[++i]));
    }
    blocks.push({ kind: "text", text: joinWords(parts) });
    i++;
  }
  return blocks;
}

function toLines(items: PositionedText[]): Line[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: PositionedText[][] = [];
  for (const item of sorted) {
    const row = rows.at(-1);
    if (row && Math.abs(row[0].y - item.y) <= row[0].fontSize * 0.3) row.push(item);
    else rows.push([item]);
  }
  return rows.map((row) => {
    row.sort((a, b) => a.x - b.x);
    const segments: Segment[] = [];
    for (const item of row) {
      const last = segments.at(-1);
      const gap = last ? item.x - last.x1 : Infinity;
      if (last && gap <= CELL_GAP) {
        last.text += gap > item.fontSize * 0.15 && !last.text.endsWith(" ") ? ` ${item.str}` : item.str;
        last.x1 = Math.max(last.x1, item.x + item.width);
      } else {
        segments.push({ x0: item.x, x1: item.x + item.width, text: item.str });
      }
    }
    for (const segment of segments) segment.text = segment.text.replace(/\s+/g, " ").trim();
    return { y: row[0].y, fontSize: round(row[0].fontSize), segments };
  });
}

function headingLevel(fontSize: number): number | null {
  return HEADING_SIZES.find((size) => fontSize >= size.min)?.level ?? null;
}

function isBullet(line: Line): boolean {
  return line.segments[0].text === "•" || line.segments[0].text.startsWith("• ");
}

/** `next` is the line below `line`, no more than `factor` line heights down. */
function follows(line: Line, next: Line, factor: number): boolean {
  return line.y - next.y <= line.fontSize * factor;
}

/** `next` continues the same paragraph or bullet, whose text starts at `x`. */
function continuesAt(line: Line, next: Line, x: number): boolean {
  return (
    next.fontSize === line.fontSize &&
    follows(line, next, 1.6) &&
    Math.abs(next.segments[0].x0 - x) <= 2 &&
    !isBullet(next) &&
    headingLevel(next.fontSize) === null
  );
}

/**
 * The index of the last line of a table that starts at `start`, or `start` when there's no table. A
 * table runs while its lines keep the font size and spacing, and either split into cells or start
 * inside the table's left edge (a cell's wrapped text).
 */
function tableExtent(lines: Line[], start: number): number {
  const first = lines[start];
  const left = first.segments[0].x0;
  let end = start;
  while (end + 1 < lines.length) {
    const next = lines[end + 1];
    const sameSize = Math.abs(next.fontSize - first.fontSize) <= 0.6;
    if (!sameSize || !follows(lines[end], next, 2.2) || isBullet(next) || headingLevel(next.fontSize) !== null) break;
    if (next.segments.length === 1 && next.segments[0].x0 < left - 1) break;
    end++;
  }
  return end;
}

/**
 * Splits a table's lines into rows and cells. Columns are the x ranges that some cell covers, so
 * the gutters between them are empty in every line; that holds for right-aligned numbers too. A
 * row starts where the gap to the line above is wider than a wrapped line's.
 */
export function tableRows(lines: Line[]): string[][] {
  // 🐨 Find the columns from every line at once. Take all the segments of all the lines, sorted by where they
  //    start (`x0`). Walk them left to right: a segment that starts inside the column you're building (at most 1
  //    point past its right edge) widens it to the segment's `x1`; any other segment starts a new column.
  // 🐨 Find the rows. The first line starts one. After that a line starts a new row when the gap down from the line
  //    above (`lines[i - 1].y - line.y`) is more than 1.4 times its font size; a smaller gap is a wrapped line of
  //    the same row.
  // 🐨 Put each segment of a line in its row, in the column whose range holds the segment's `x0` (allow half a
  //    point to the left of the column). Join each cell's pieces with joinWords, and return the rows, header first.
  //    A cell nothing landed in is "".
  //
  // 💰 `[...list].sort((a, b) => a.x0 - b.x0)` sorts by x0. `columns.findIndex((c) => ...)` finds a column's index.
  //    `columns.map(() => [])` makes one empty list per column for a new row.
  //
  // 🦉 Why columns from every line, not one line at a time. In one line, a cell is just "the third segment". But a
  //    row's wrapped line holds only the cells that wrapped: on the error code page, the line under KP-1001 is
  //    "recognised" (the Meaning column) and "key (kp_test_) in the sandbox" (the last column). Counted per line,
  //    "recognised" is segment 1, so it lands under Code. That's the classic mistake. Across all lines, though, the
  //    gutters (the white space between columns) are empty in every line, so their x ranges give the columns.
  // 🦉 Why that holds for right-aligned numbers. "£6,200,000" starts at x 255 and "£95,000" at 268: no two start
  //    at the same x, so matching starts against the header's breaks. Both still sit inside the column's range,
  //    which reaches from the leftmost start to the rightmost end of anything in it.
  // 🦉 Why rows by the gap. A wrapped line sits one line height under the line above (11.2 points at 9pt type);
  //    the renderer leaves extra room before a new row (about 16). 1.4 times the font size, 12.6 points here, falls
  //    between. One row per line would turn the five error codes into 13 rows, the half-sentences each on its own.
  //
  // 📜 https://www.markdownguide.org/extended-syntax/#tables (what tableBlock writes)
  //
  // 🚨 The tests check that a wrapped line stays in its row and its column (even when it only fills the last
  //    column), that an empty cell keeps its place, that right-aligned numbers land in their column, and that page
  //    1 of the Payments API error code catalogue gives the five codes as five rows under their header.
  throw new Error(`tableRows(${lines.length} lines) isn't written yet`);
}

function lineText(line: Line): string {
  return line.segments.map((segment) => segment.text).join(" ");
}

function joinWords(parts: string[]): string {
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function round(size: number): number {
  return Math.round(size * 10) / 10;
}
