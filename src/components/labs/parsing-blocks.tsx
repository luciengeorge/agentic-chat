import type { Block } from "#learn/parse/types";

/** A table block's markdown back as rows of cells, the header first; the `| --- |` line is dropped. */
export function tableCells(markdown: string): string[][] {
  return markdown
    .split("\n")
    .filter((_, i) => i !== 1)
    .map((line) =>
      line
        .replace(/^\|\s?/, "")
        .replace(/\s?\|$/, "")
        .split(/(?<!\\) \| /)
        .map((cell) => cell.replaceAll("\\|", "|")),
    );
}

/** One parsed page's blocks, each labelled with its kind, the way chunking will see them. */
export function ParsedBlocks({ blocks }: { blocks: Block[] }) {
  if (blocks.length === 0) return <p className="text-sm text-muted-foreground">No blocks on this page.</p>;
  return (
    <ol className="flex flex-col gap-2">
      {blocks.map((block, i) => (
        <li key={i} className="flex gap-3 rounded-lg border px-3 py-2">
          <span className="w-14 shrink-0 pt-0.5 font-mono text-xs text-muted-foreground">
            {block.kind === "heading" ? `h${block.level}` : block.kind === "table" ? `table ${block.rows}` : "text"}
          </span>
          {block.kind === "heading" ? (
            <p className="min-w-0 text-sm font-semibold">{block.text}</p>
          ) : block.kind === "text" ? (
            <p className="min-w-0 text-sm leading-relaxed break-words whitespace-pre-wrap">{block.text}</p>
          ) : (
            <TableBlock markdown={block.markdown} />
          )}
        </li>
      ))}
    </ol>
  );
}

function TableBlock({ markdown }: { markdown: string }) {
  const [header, ...rows] = tableCells(markdown);
  return (
    <div className="min-w-0 flex-1 overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b">
            {header.map((cell, i) => (
              <th key={i} className="px-2 py-1 font-medium">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className="border-b last:border-0">
              {row.map((cell, i) => (
                <td key={i} className="px-2 py-1 align-top">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
