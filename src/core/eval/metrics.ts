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

function requireLabels(labelCount: number) {
  if (!Number.isInteger(labelCount) || labelCount < 1)
    throw new RangeError(`need at least one label, got ${labelCount}`);
}

/** recall@k: the share of the labels found in the top k. */
export function recallAtK(judged: (number | null)[], labelCount: number, k: number): number {
  requireLabels(labelCount);
  return judged.slice(0, k).filter((hit) => hit !== null).length / labelCount;
}

/** 1 divided by the rank of the first chunk that finds a label; 0 when none does. Averaged, it's MRR. */
export function reciprocalRank(judged: (number | null)[]): number {
  const first = judged.findIndex((hit) => hit !== null);
  return first === -1 ? 0 : 1 / (first + 1);
}

const discount = (rank: number) => 1 / Math.log2(rank + 1);

/**
 * NDCG@k with binary gains: each found label is worth 1, discounted by log2(rank + 1). It's divided by the best
 * possible score, every label in the first places, so a perfect ranking scores 1.
 */
export function ndcgAtK(judged: (number | null)[], labelCount: number, k: number): number {
  requireLabels(labelCount);
  let dcg = 0;
  for (const [i, hit] of judged.slice(0, k).entries()) if (hit !== null) dcg += discount(i + 1);
  let ideal = 0;
  for (let rank = 1; rank <= Math.min(labelCount, k); rank++) ideal += discount(rank);
  return dcg / ideal;
}

export function mean(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
