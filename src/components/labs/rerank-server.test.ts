// @vitest-environment node
import { describe, expect, it } from "vitest";

import { noRewriter } from "#learn/query/rewrite";
import { overlapReranker } from "#learn/rerank/rerank";
import { setupAclWorld, WORLD_EMBEDDER } from "@/core/acl/testing";
import { withTenantOn } from "@/db/tenant";
import { postgresAvailable } from "@/db/testing";

import { rerankRun } from "./rerank-server";

const world = setupAclWorld({ chunks: true });

describe.skipIf(!postgresAvailable)("the rerank lab", () => {
  const run = (depth: number) => {
    const w = world.get();
    return rerankRun(
      {
        withTenant: (tenantId, fn) => withTenantOn(w.t.appDb, tenantId, fn),
        embedder: WORLD_EMBEDDER,
        reranker: overlapReranker(),
        rewriter: noRewriter,
      },
      { tenantId: w.tenants.kestrel, userId: w.user("leo.martin") },
      "What is the hotel limit for a night in London?",
      depth,
    );
  };

  it("returns every candidate the reranker read, in its order, with its place in the fused order", async () => {
    const result = await run(30);
    expect(result.reranker).toBe("fake-overlap-v1");
    expect(result.rows).toHaveLength(30);
    expect(result.rows.map((row) => row.reranked)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(new Set(result.rows.map((row) => row.fused))).toEqual(new Set(Array.from({ length: 30 }, (_, i) => i + 1)));
    const scores = result.rows.map((row) => row.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("reads only `depth` candidates", async () => {
    const result = await run(8);
    expect(result.rows).toHaveLength(8);
    expect(Math.max(...result.rows.map((row) => row.fused))).toBe(8);
    await expect(run(0)).rejects.toThrow(RangeError);
  });
});
