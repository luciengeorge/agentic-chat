import type { ParsedDocument, ParseDeps } from "#learn/parse/types";

import { parseDocx } from "#learn/parse/docx";
import { parseMarkdown } from "#learn/parse/markdown";
import { type PageRange, parsePdf } from "#learn/parse/pdf";

export { pdfPageCount, type PageRange } from "#learn/parse/pdf";

export const PDF = "application/pdf";
export const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const MARKDOWN = "text/markdown";

export class UnsupportedDocumentError extends Error {
  override name = "UnsupportedDocumentError";
}

export interface ParseOptions {
  /** PDFs only: parse just these pages. Page numbers stay those of the whole document. */
  pages?: PageRange;
}

export async function parse(
  bytes: Uint8Array,
  mimeType: string,
  deps: ParseDeps,
  options: ParseOptions = {},
): Promise<ParsedDocument> {
  const type = mimeType.split(";")[0].trim().toLowerCase();
  if (options.pages && type !== PDF) throw new UnsupportedDocumentError(`a page range needs a PDF, not ${type}`);
  if (type === PDF) {
    const pages = await parsePdf(bytes, deps, options.pages);
    return { mimeType: type, pages, blocks: pages.flatMap((page) => page.blocks) };
  }
  if (type === DOCX) return { mimeType: type, pages: null, blocks: await parseDocx(bytes) };
  if (type === MARKDOWN || type === "text/plain") {
    return { mimeType: type, pages: null, blocks: parseMarkdown(new TextDecoder().decode(bytes)) };
  }
  throw new UnsupportedDocumentError(`can't parse ${mimeType}`);
}
