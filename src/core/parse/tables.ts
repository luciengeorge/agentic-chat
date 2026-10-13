import type { Block } from "#learn/parse/types";

/** A table as markdown: the first row is the header. `rows` counts the rows under it. */
export function tableBlock(rows: string[][]): Block & { kind: "table" } {
  const width = Math.max(...rows.map((row) => row.length));
  const line = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => escapeCell(cells[i] ?? "")).join(" | ")} |`;
  const [header, ...body] = rows;
  const markdown = [line(header), line(Array(width).fill("---")), ...body.map(line)].join("\n");
  return { kind: "table", markdown, rows: body.length };
}

function escapeCell(text: string): string {
  return text.replace(/\s+/g, " ").trim().replaceAll("|", "\\|");
}
