import type { ReactNode } from "react";

/**
 * A small markdown renderer for model answers: headings, paragraphs, lists, tables, code and inline emphasis.
 * It builds React elements, never HTML, and it renders no links and no images: a link's text and an image's alt
 * text stay, their URLs go. So an answer can't make the browser fetch anything (the M0 backlog's exfiltration
 * case: an injected prompt asking for an image whose URL carries a secret).
 */

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "code"; text: string };

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const FENCE = /^\s*```/;

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());

export function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) code.push(lines[i]);
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      continue;
    }
    if (line.trim().startsWith("|") && TABLE_SEPARATOR.test(lines[i + 1] ?? "")) {
      flush();
      const header = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].trim().startsWith("|"); i++) rows.push(cells(lines[i]));
      i--;
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    const item = BULLET.exec(line) ?? NUMBERED.exec(line);
    if (item) {
      flush();
      const ordered = !BULLET.test(line);
      const last = blocks.at(-1);
      if (last?.kind === "list" && last.ordered === ordered) last.items.push(item[1]);
      else blocks.push({ kind: "list", ordered, items: [item[1]] });
      continue;
    }
    const last = blocks.at(-1);
    if (!paragraph.length && last?.kind === "list" && /^\s{2,}/.test(line)) {
      last.items[last.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

const INLINE =
  /(\[\[.+?\]\])|`([^`]+)`|\*\*(.+?)\*\*|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?!\w)|(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)|!\[([^\]]*)\]\([^)]*\)|\[([^\]]+)\]\([^)]*\)/g;

export type RenderCitation = (marker: string, key: string) => ReactNode;

/** Plain text, with whatever `highlight` matches wrapped in <mark>. */
function marked(text: string, highlight: RegExp | undefined, key: string): ReactNode[] {
  if (!highlight) return [text];
  return text.split(highlight).map((part, i) =>
    i % 2 === 1 ? (
      <mark key={`${key}-m${i}`} className="rounded-sm bg-primary/15 px-0.5 text-foreground">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

export function renderInline(
  text: string,
  renderCitation: RenderCitation,
  keyPrefix = "i",
  highlight?: RegExp,
): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  const plain = (value: string, key: string) => out.push(...marked(value, highlight, key));
  for (const match of text.matchAll(INLINE)) {
    const key = `${keyPrefix}-${match.index}`;
    if (match.index > last) plain(text.slice(last, match.index), `${key}-t`);
    const [, citation, code, bold, star, underscore, imageAlt, linkText] = match;
    if (citation) out.push(renderCitation(citation, key));
    else if (code !== undefined) out.push(<code key={key}>{code}</code>);
    else if (bold !== undefined)
      out.push(<strong key={key}>{renderInline(bold, renderCitation, key, highlight)}</strong>);
    else if (star !== undefined || underscore !== undefined)
      out.push(<em key={key}>{renderInline(star ?? underscore, renderCitation, key, highlight)}</em>);
    else if (imageAlt !== undefined) plain(imageAlt, key);
    else if (linkText !== undefined) out.push(...renderInline(linkText, renderCitation, key, highlight));
    last = match.index + match[0].length;
  }
  if (last < text.length) plain(text.slice(last), `${keyPrefix}-end`);
  return out;
}

/** While a reply streams, the end may hold half a citation (`[[S1: "reimb`): hide it until it closes. */
export const withoutOpenCitation = (text: string) => text.replace(/\[\[(?:(?!\]\]).)*$/s, "");

export function Markdown({
  text,
  renderCitation,
  highlight,
}: {
  text: string;
  renderCitation: RenderCitation;
  /** A regex with one capturing group around the whole match, `g` and `i` as needed: matches get a <mark>. */
  highlight?: RegExp;
}) {
  return (
    <>
      {parseBlocks(text).map((block, b) => {
        const key = `b${b}`;
        const inline = (value: string, k = key) => renderInline(value, renderCitation, k, highlight);
        switch (block.kind) {
          case "heading":
            return block.level <= 2 ? <h3 key={key}>{inline(block.text)}</h3> : <h4 key={key}>{inline(block.text)}</h4>;
          case "paragraph":
            return <p key={key}>{inline(block.text)}</p>;
          case "code":
            return (
              <pre key={key}>
                <code>{block.text}</code>
              </pre>
            );
          case "list": {
            const items = block.items.map((item, n) => <li key={n}>{inline(item, `${key}-${n}`)}</li>);
            return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
          }
          case "table":
            return (
              <div key={key} className="not-prose my-4 overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      {block.header.map((cell, c) => (
                        <th key={c} className="px-3 py-2 text-left font-medium">
                          {inline(cell, `${key}-h${c}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={r} className="border-t">
                        {row.map((cell, c) => (
                          <td key={c} className="px-3 py-2 align-top tabular-nums">
                            {inline(cell, `${key}-${r}-${c}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </>
  );
}
