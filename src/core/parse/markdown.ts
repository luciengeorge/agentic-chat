import type { Block } from "#learn/parse/types";

import { tableBlock } from "#learn/parse/tables";

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** Markdown passes through as blocks: ATX headings, pipe tables, list items and paragraphs. */
export function parseMarkdown(source: string): Block[] {
  const lines = stripFrontmatter(source).split(/\r?\n/);
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    const text = paragraph.join(" ").replace(/\s+/g, " ").trim();
    if (text) blocks.push({ kind: "text", text });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (line.trimStart().startsWith("```")) {
      flush();
      const code = [line];
      while (i + 1 < lines.length) {
        code.push(lines[++i]);
        if (lines[i].trimStart().startsWith("```")) break;
      }
      blocks.push({ kind: "text", text: code.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      continue;
    }
    if (line.includes("|") && TABLE_SEPARATOR.test(lines[i + 1] ?? "")) {
      flush();
      const rows = [cells(line)];
      i++;
      while (i + 1 < lines.length && lines[i + 1].includes("|") && lines[i + 1].trim() !== "") {
        rows.push(cells(lines[++i]));
      }
      blocks.push(tableBlock(rows));
      continue;
    }
    if (LIST_ITEM.test(line)) {
      flush();
      paragraph = [line.trim()];
      while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]) && !LIST_ITEM.test(lines[i + 1])) {
        paragraph.push(lines[++i]);
      }
      flush();
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replaceAll("\\|", "|").trim());
}

function stripFrontmatter(source: string): string {
  return source.startsWith("---\n") ? source.replace(/^---\n[\s\S]*?\n---\n/, "") : source;
}
