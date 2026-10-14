import { sql } from "drizzle-orm";

import type { Tx } from "@/db/tenant";

import { nearest, type NearestQuery } from "./hnsw";

/**
 * The exact k nearest ids: every row's distance computed and sorted. Index scans are switched off for the
 * transaction, so the planner can't answer from the HNSW graph. This is the ground truth ANN is measured against.
 */
export async function exactNearest(tx: Tx, query: NearestQuery): Promise<string[]> {
  await tx.execute(sql`SET LOCAL enable_indexscan = off`);
  await tx.execute(sql`SET LOCAL enable_bitmapscan = off`);
  return nearest(tx, query);
}

/** recall@k: the share of the true k nearest that the approximate search found in its first k. */
export function recallAtK(found: readonly string[], truth: readonly string[], k: number): number {
  const expected = truth.slice(0, k);
  if (expected.length === 0) throw new RangeError("no true neighbours to compare with");
  const got = new Set(found.slice(0, k));
  return expected.filter((id) => got.has(id)).length / expected.length;
}
