// 👨‍💼 Kestrel's golden set says which pages answer each question. Before recall or MRR can mean anything, every
//    chunk a ranking returned has to be checked against those pages: does it find one, and which? `pnpm eval` and
//    the eval dashboard call this file for every question, after every change to retrieval.
//
// 🦉 Already written in this file: the `Label` and `RankedChunk` types. Step 2 adds the metrics that read what
//    your `judge` returns.

/**
 * Ranking metrics over golden labels. A label is a document page (or a whole document, for md and docx, which have
 * no pages), never a chunk id: chunk ids change whenever chunking does, and a page is what a person can check.
 */

export interface Label {
  path: string;
  /** null for md and docx: any chunk of the document hits it. */
  page: number | null;
}

/** What the metrics need from a retrieved chunk. */
export interface RankedChunk {
  path: string;
  pageStart: number | null;
  pageEnd: number | null;
}

/** The chunk is from the labelled document and, for a paged label, its pages include the label's page. */
export function hitsLabel(label: Label, chunk: RankedChunk): boolean {
  // 🐨 Another document never hits. A label with no page is hit by any chunk of its document.
  // 🐨 A paged label needs a paged chunk whose range includes the page: `pageStart <= page <= pageEnd`. A chunk of
  //    one page may have `pageEnd` null; then its range is `pageStart` alone.
  // 🐨 The classic mistake: comparing `chunk.pageStart === label.page`. Daniel's offsite notes chunk covers pages 1
  //    and 2, starts at 1, and would pass; one that covers 2 to 3 would miss a label on page 3.
  //
  // 💰 `chunk.pageEnd ?? chunk.pageStart`.
  //
  // 🦉 Why a page, never a chunk id. Chunk ids are made when a document is chunked. Section 04 changed the chunker
  //    four times; each time every id changed, and a golden set keyed by ids would have had to be relabelled by
  //    hand. A page stays put: the London hotel limit is on page 2 of the expenses policy whatever the chunker
  //    does, and a person can open the PDF and check.
  // 🦉 Why a pageless chunk never hits a paged label. A Word document's chunk has no page. If it counted for any
  //    page of any label, it would hit labels it has nothing to do with.
  //
  // 🚨 The tests check one page, a range, another document, a pageless label and a pageless chunk.
  throw new Error(`hitsLabel(${JSON.stringify(label)}, ${JSON.stringify(chunk)}) isn't written yet`);
}

/**
 * For each chunk in rank order, the index of the label it finds, or null. A chunk finds the first label it hits
 * that no higher chunk found already, so three chunks of one page count once: a ranking can't score by repeating
 * itself.
 */
export function judge(chunks: RankedChunk[], labels: Label[]): (number | null)[] {
  // 🐨 Walk the chunks in rank order, keeping the label indexes found so far. For each chunk, find the first label
  //    it hits that isn't found yet: that index goes in the chunk's place, and the label is found. A chunk that
  //    hits nothing new gets null.
  // 🐨 The classic mistake: taking the first label a chunk hits, found or not, then dropping it as a repeat. A
  //    chunk covering pages 2 to 3, below one that already found page 2, must still find page 3's label.
  //
  // 💰 `labels.findIndex((label, i) => ...)`, a `Set` of found indexes.
  //
  // 🦉 Why each label once. Retrieval often returns several chunks of one page (a long table split in two, or
  //    the same page reached by a rewrite). Counted every time, a ranking that repeated one page five times would
  //    look like it found five things. Daniel's tenth chunk is the memo's page 1 again: label 0 was found at rank
  //    2, so it finds nothing.
  //
  // 🚨 The tests check repeats, a range that finds a second label, and every question of the 14 October report.
  throw new Error(`judge(${chunks.length} chunks, ${labels.length} labels) isn't written yet`);
}
