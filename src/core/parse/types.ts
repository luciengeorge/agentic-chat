export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "text"; text: string }
  | { kind: "table"; markdown: string; rows: number };

export interface Page {
  number: number;
  blocks: Block[];
  method: "text-layer" | "ocr";
  ocrConfidence?: number;
}

/** `pages` is null for md and docx; `blocks` is every block in reading order. */
export interface ParsedDocument {
  mimeType: string;
  pages: Page[] | null;
  blocks: Block[];
}

/** Renders one page (1-based) of a PDF to a PNG. */
export type Rasterise = (pdf: Uint8Array, pageNumber: number) => Promise<Uint8Array>;

export interface ParseDeps {
  rasterise: Rasterise;
  ocr: (png: Uint8Array) => Promise<{ text: string; confidence: number }>;
}

/** Implemented by `parse` in `#learn/parse/parse`. */
export type Parse = (bytes: Uint8Array, mimeType: string, deps: ParseDeps) => Promise<ParsedDocument>;
