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

interface Segment {
  x0: number;
  x1: number;
  text: string;
}

interface Line {
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
function tableRows(lines: Line[]): string[][] {
  const spans = lines.flatMap((line) => line.segments).sort((a, b) => a.x0 - b.x0);
  const columns: { x0: number; x1: number }[] = [];
  for (const span of spans) {
    const last = columns.at(-1);
    if (last && span.x0 <= last.x1 + 1) last.x1 = Math.max(last.x1, span.x1);
    else columns.push({ x0: span.x0, x1: span.x1 });
  }
  const rows: string[][][] = [];
  lines.forEach((line, i) => {
    if (i === 0 || lines[i - 1].y - line.y > line.fontSize * 1.4) rows.push(columns.map(() => []));
    const row = rows.at(-1)!;
    for (const segment of line.segments) {
      const column = columns.findIndex((c) => segment.x0 >= c.x0 - 0.5 && segment.x0 <= c.x1);
      row[column].push(segment.text);
    }
  });
  return rows.map((row) => row.map(joinWords));
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
