// Runs our parser and docling over a few trap documents and prints where they differ, page by page.
// Start docling first: `docker compose --profile docling up -d docling` (about 4.4 GB, on :5001).
//
//   tsx scripts/parse-compare.ts [doc-id ...]
//
// A comparison tool for section 03, not part of ingestion.
import type { Block, ParsedDocument } from "#learn/parse/types";

import { parse } from "#learn/parse/parse";
import { type CorpusFile, corpusFile } from "@/core/parse/corpus.test-helpers";
import { ocrPng, terminateOcr } from "@/lib/parse/ocr";
import { rasterisePage } from "@/lib/parse/rasterise.server";

const DOCLING_URL = process.env.DOCLING_URL ?? "http://127.0.0.1:5001";
const DEFAULT_DOCS = [
  "finance-q3-2026-quarterly-report",
  "legal-contract-register",
  "legal-contract-kpc-2026-0142-ashgrove-msa",
  "finance-ap-invoice-batch-b-2026-117",
  "hr-case-note-2026-014",
  "company-partner-onboarding-brightwell",
];
const IDENTIFIER = /\b(?:KPC-\d{4}-\d{4}|KP-\d{4}|K[ACP]-[A-Z]+-(?:\d+|BUY)|[A-Z]{2,4}-\d{4}-\d{3,4})\b/g;

/** What both parsers are compared on, for one page (or the whole document when it has no pages). */
interface PageView {
  headings: string[];
  /** Rows by columns, header row included. */
  tables: string[];
  words: Set<string>;
  identifiers: Set<string>;
  note: string;
}

interface DoclingProv {
  page_no: number;
}
interface DoclingText {
  label: string;
  text: string;
  content_layer?: string;
  prov?: DoclingProv[];
}
interface DoclingTable {
  content_layer?: string;
  prov?: DoclingProv[];
  data: { num_rows: number; num_cols: number; table_cells: { text: string }[] };
}
interface DoclingDocument {
  texts: DoclingText[];
  tables: DoclingTable[];
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s|]+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}£€]+|[^\p{L}\p{N}%]+$/gu, ""))
    .filter((word) => word.length > 1 && word !== "---");
}

function emptyView(note = ""): PageView {
  return { headings: [], tables: [], words: new Set(), identifiers: new Set(), note };
}

function addText(view: PageView, text: string) {
  for (const word of words(text)) view.words.add(word);
  for (const id of text.match(IDENTIFIER) ?? []) view.identifiers.add(id);
}

function oursByPage(doc: ParsedDocument): Map<number | null, PageView> {
  const pages = new Map<number | null, PageView>();
  const add = (number: number | null, blocks: Block[], note: string) => {
    const view = emptyView(note);
    for (const block of blocks) {
      if (block.kind === "heading") view.headings.push(block.text);
      if (block.kind === "table") {
        const columns = block.markdown.split("\n")[0].split(" | ").length;
        view.tables.push(`${block.rows + 1}x${columns}`);
      }
      addText(view, block.kind === "table" ? block.markdown : block.text);
    }
    pages.set(number, view);
  };
  if (!doc.pages) add(null, doc.blocks, "");
  else {
    for (const page of doc.pages) {
      add(page.number, page.blocks, page.method === "ocr" ? `ocr ${page.ocrConfidence}` : "text");
    }
  }
  return pages;
}

function doclingByPage(doc: DoclingDocument): Map<number | null, PageView> {
  const pages = new Map<number | null, PageView>();
  const view = (prov: DoclingProv[] | undefined) => {
    const number = prov?.[0]?.page_no ?? null;
    if (!pages.has(number)) pages.set(number, emptyView());
    return pages.get(number)!;
  };
  for (const text of doc.texts) {
    if (text.content_layer === "furniture" || /^page_(header|footer)$/.test(text.label)) continue;
    const page = view(text.prov);
    if (text.label === "title" || text.label === "section_header") page.headings.push(text.text);
    addText(page, text.text);
  }
  for (const table of doc.tables) {
    if (table.content_layer === "furniture") continue;
    const page = view(table.prov);
    page.tables.push(`${table.data.num_rows}x${table.data.num_cols}`);
    for (const cell of table.data.table_cells) addText(page, cell.text);
  }
  return pages;
}

async function docling(file: CorpusFile): Promise<{ doc: DoclingDocument; seconds: number }> {
  const form = new FormData();
  const name = `${file.docId}.${file.mimeType === "application/pdf" ? "pdf" : "docx"}`;
  form.append("files", new Blob([file.bytes()], { type: file.mimeType }), name);
  for (const [key, value] of [
    ["to_formats", "json"],
    ["do_ocr", "true"],
    ["force_ocr", "false"],
    ["image_export_mode", "placeholder"],
  ]) {
    form.append(key, value);
  }
  const started = Date.now();
  const task = await json<{ task_id: string }>(
    await fetch(`${DOCLING_URL}/v1/convert/file/async`, { method: "POST", body: form }),
  );
  for (;;) {
    const status = await json<{ task_status: string }>(await fetch(`${DOCLING_URL}/v1/status/poll/${task.task_id}`));
    if (status.task_status === "success") break;
    if (status.task_status === "failure") throw new Error(`docling failed on ${file.docId}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const result = await json<{ document: { json_content: DoclingDocument } }>(
    await fetch(`${DOCLING_URL}/v1/result/${task.task_id}`),
  );
  return { doc: result.document.json_content, seconds: (Date.now() - started) / 1000 };
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`${response.url}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

function minus<T>(a: Set<T>, b: Set<T>): T[] {
  return [...a].filter((item) => !b.has(item));
}

function share(a: Set<string>, b: Set<string>): string {
  if (a.size === 0) return "-";
  return `${Math.round((100 * (a.size - minus(a, b).length)) / a.size)}%`;
}

function compare(ours: Map<number | null, PageView>, theirs: Map<number | null, PageView>) {
  const numbers = [...new Set([...ours.keys(), ...theirs.keys()])].sort((a, b) => (a ?? 0) - (b ?? 0));
  for (const number of numbers) {
    const a = ours.get(number) ?? emptyView("missing");
    const b = theirs.get(number) ?? emptyView("missing");
    console.log(`  page ${number ?? "-"} (ours: ${a.note || "-"})`);
    console.log(
      `    words: ${share(a.words, b.words)} of ours in docling, ${share(b.words, a.words)} of docling's in ours`,
    );
    console.log(`    tables: ours [${a.tables.join(", ")}], docling [${b.tables.join(", ")}]`);
    const headings = {
      ours: minus(new Set(a.headings), new Set(b.headings)),
      docling: minus(new Set(b.headings), new Set(a.headings)),
    };
    if (headings.ours.length || headings.docling.length) {
      console.log(
        `    headings only ours: ${JSON.stringify(headings.ours)}; only docling: ${JSON.stringify(headings.docling)}`,
      );
    }
    const ids = { ours: minus(a.identifiers, b.identifiers), docling: minus(b.identifiers, a.identifiers) };
    if (ids.ours.length || ids.docling.length) {
      console.log(
        `    identifiers only ours: ${ids.ours.join(" ") || "-"}; only docling: ${ids.docling.join(" ") || "-"}`,
      );
    }
    const onlyOurs = minus(a.words, b.words).slice(0, 12);
    const onlyDocling = minus(b.words, a.words).slice(0, 12);
    if (onlyOurs.length) console.log(`    words only ours: ${onlyOurs.join(" ")}`);
    if (onlyDocling.length) console.log(`    words only docling: ${onlyDocling.join(" ")}`);
  }
}

try {
  const ids = process.argv.slice(2);
  for (const docId of ids.length ? ids : DEFAULT_DOCS) {
    const file = corpusFile(docId);
    const started = Date.now();
    const ours = await parse(file.bytes(), file.mimeType, { rasterise: rasterisePage, ocr: ocrPng });
    const oursSeconds = (Date.now() - started) / 1000;
    const theirs = await docling(file);
    console.log(
      `\n${docId} (${file.format}; traps: ${file.traps.join(", ") || "none"}): ours ${oursSeconds.toFixed(1)} s, docling ${theirs.seconds.toFixed(1)} s`,
    );
    compare(oursByPage(ours), doclingByPage(theirs.doc));
  }
} finally {
  await terminateOcr();
}
