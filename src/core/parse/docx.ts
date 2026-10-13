import mammoth from "mammoth";

import type { Block } from "#learn/parse/types";

import { tableBlock } from "#learn/parse/tables";

/** DOCX through mammoth's HTML: headings, paragraphs, list items and tables. Images are dropped. */
export async function parseDocx(bytes: Uint8Array): Promise<Block[]> {
  const { value } = await mammoth.convertToHtml(
    { buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) },
    { convertImage: mammoth.images.imgElement(async () => ({ src: "" })) },
  );
  return htmlBlocks(value);
}

const TAG = /<(\/?)([a-z][a-z0-9]*)[^>]*?(\/?)>|([^<]+)/gi;

/** Walks the small, well-formed HTML mammoth writes. Not a general HTML parser. */
export function htmlBlocks(html: string): Block[] {
  const blocks: Block[] = [];
  let text = "";
  let heading: number | null = null;
  let listDepth = 0;
  let table: string[][] | null = null;
  let cell: string[] | null = null;

  const flushText = () => {
    const clean = text.replace(/\s+/g, " ").trim();
    text = "";
    if (!clean) return;
    if (cell) cell.push(clean);
    else if (heading !== null) blocks.push({ kind: "heading", level: heading, text: clean });
    else blocks.push({ kind: "text", text: listDepth > 0 ? `- ${clean}` : clean });
  };

  for (const match of html.matchAll(TAG)) {
    const [, closing, name, , chars] = match;
    if (chars !== undefined) {
      text += decodeEntities(chars);
      continue;
    }
    const tag = name.toLowerCase();
    const open = closing === "";
    if (/^h[1-6]$/.test(tag)) {
      flushText();
      heading = open ? Number(tag[1]) : null;
    } else if (tag === "p" || tag === "li") {
      flushText();
    } else if (tag === "br") {
      text += " ";
    } else if (tag === "ul" || tag === "ol") {
      flushText();
      listDepth += open ? 1 : -1;
    } else if (tag === "table") {
      flushText();
      if (open) table = [];
      else if (table) {
        if (table.length > 0) blocks.push(tableBlock(table));
        table = null;
      }
    } else if (tag === "tr" && open) {
      table?.push([]);
    } else if (tag === "td" || tag === "th") {
      if (open) cell = [];
      else {
        flushText();
        if (cell) table?.at(-1)?.push(cell.join(" "));
        cell = null;
      }
    }
  }
  flushText();
  return blocks;
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39);/gi, (_, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(Number(lower.slice(1)));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[lower] ?? "";
  });
}
