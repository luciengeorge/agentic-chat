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
  if (label.path !== chunk.path) return false;
  if (label.page === null) return true;
  if (chunk.pageStart === null) return false;
  return chunk.pageStart <= label.page && label.page <= (chunk.pageEnd ?? chunk.pageStart);
}

/**
 * For each chunk in rank order, the index of the label it finds, or null. A chunk finds the first label it hits
 * that no higher chunk found already, so three chunks of one page count once: a ranking can't score by repeating
 * itself.
 */
export function judge(chunks: RankedChunk[], labels: Label[]): (number | null)[] {
  const found = new Set<number>();
  return chunks.map((chunk) => {
    const index = labels.findIndex((label, i) => !found.has(i) && hitsLabel(label, chunk));
    if (index === -1) return null;
    found.add(index);
    return index;
  });
}
