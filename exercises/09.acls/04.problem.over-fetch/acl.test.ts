// @vitest-environment node
import { describe, expect, it } from "vitest";

import { noRewriter } from "#learn/query/rewrite";
import { overlapReranker } from "#learn/rerank/rerank";
import { candidateDocuments, canRead, decideChunks, viewerPrincipals } from "#learn/retrieve/acl";
import { createRetrieve } from "#learn/retrieve/retrieve";
import { setupAclWorld, WORLD_EMBEDDER } from "@/core/acl/testing";
import { withTenantOn } from "@/db/tenant";
import { postgresAvailable } from "@/db/testing";

const world = setupAclWorld({ chunks: true });

const HERON_QUESTION = "Project Heron acquisition of Lumen Ledger board vote";
const HERON = "/Exec/Project Heron Board Memo.pdf";
const POLICY = "/HR/Policies/Travel and Expenses Policy v2.pdf";
const REGISTER = "/Legal/Contracts/Contract Register 2026-09-28.pdf";
const CHECKLIST = "/Finance/Month-End Close Checklist.md";

describe.skipIf(!postgresAvailable)("the over-fetch filter", () => {
  const retrieve = () =>
    createRetrieve({
      withTenant: (tenantId, fn) => withTenantOn(world.get().t.appDb, tenantId, fn),
      embedder: WORLD_EMBEDDER,
      reranker: overlapReranker(),
      rewriter: noRewriter,
    });
  const ask = (username: string, question: string) =>
    retrieve()({ tenantId: world.get().tenants.kestrel, userId: world.get().user(username) }, question);
  const audit = async (auditId: string) => {
    const [row] = await world.get().t.sql<{ returned: number; denied: string[] }[]>`
      SELECT cardinality(returned_ids) AS returned, denied_ids AS denied FROM retrieval_audit WHERE id = ${auditId}`;
    return row;
  };
  const chunkOf = async (path: string, ordinal = 0) => {
    const [row] = await world.get().t.sql<{ id: string }[]>`
      SELECT c.id FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path = ${path} AND c.ordinal = ${ordinal}`;
    return row.id;
  };

  describe("candidateDocuments, the pre-filter", () => {
    it("finds the ready documents any of the principals has an allow on: leo.martin's 4 reach 18", async () => {
      const w = world.get();
      const found = await w.inTenant("kestrel", async (tx) => {
        const { principalIds } = await viewerPrincipals(tx, w.user("leo.martin"), null);
        return candidateDocuments(tx, principalIds);
      });
      expect(found, "each document once").toHaveLength(new Set(found).size);
      expect(found).toHaveLength(18);
      expect(found).toContain(await w.documentId(POLICY));
      expect(found).not.toContain(await w.documentId(HERON));
    });

    it("is never narrower than the decision: every document readable() allows is a candidate, for all 31 users", async () => {
      const w = world.get();
      const users = await w.t.sql<{ id: string; name: string }[]>`
        SELECT id, name FROM principals WHERE tenant_id = ${w.tenants.kestrel} AND kind = 'user'`;
      expect(users).toHaveLength(31);
      const documents = await w.t.sql<
        { id: string }[]
      >`SELECT id FROM documents WHERE tenant_id = ${w.tenants.kestrel}`;
      for (const user of users) {
        await w.inTenant("kestrel", async (tx) => {
          const { principalIds } = await viewerPrincipals(tx, user.id, null);
          const candidates = new Set(await candidateDocuments(tx, principalIds));
          for (const { id } of documents) {
            if (await canRead(tx, user.id, id)) {
              expect(
                candidates.has(id),
                `${user.name} may read a document the pre-filter left out: match the user's id and every group in the set`,
              ).toBe(true);
            }
          }
        });
      }
    });

    it("leaves out a document that isn't ready, and finds nothing for no principals", async () => {
      const w = world.get();
      await w.t.sql`UPDATE documents SET status = 'ingesting' WHERE path = ${CHECKLIST}`;
      try {
        const found = await w.inTenant("kestrel", async (tx) => {
          const { principalIds } = await viewerPrincipals(tx, w.user("leo.martin"), null);
          return candidateDocuments(tx, principalIds);
        });
        expect(found, "search only looks in ready documents").not.toContain(await w.documentId(CHECKLIST));
        expect(await w.inTenant("kestrel", (tx) => candidateDocuments(tx, []))).toEqual([]);
      } finally {
        await w.t.sql`UPDATE documents SET status = 'ready' WHERE path = ${CHECKLIST}`;
      }
    });
  });

  describe("decideChunks, the decision over the candidates", () => {
    it("keeps the allowed ones in the order given, and lists the denied ones, in that order too", async () => {
      const w = world.get();
      const [policy, heron, register, heron2] = [
        await chunkOf(POLICY),
        await chunkOf(HERON),
        await chunkOf(REGISTER),
        await chunkOf(HERON, 1),
      ];
      const { allowed, denied } = await w.inTenant("kestrel", (tx) =>
        decideChunks(tx, w.user("leo.martin"), [register, heron, policy, heron2]),
      );
      expect(
        allowed.map((chunk) => chunk.id),
        "allowed in the fused order you were given: the reranker reads the first 30 of them",
      ).toEqual([register, policy]);
      expect(denied, "the denied ids go in the audit: keep them, don't filter them out in SQL").toEqual([
        heron,
        heron2,
      ]);
      for (const order of [
        [policy, register],
        [register, policy],
      ]) {
        const decided = await w.inTenant("kestrel", (tx) => decideChunks(tx, w.user("leo.martin"), order));
        expect(
          decided.allowed.map((chunk) => chunk.id),
          "follow the order of the ids you're given, not the order the rows come back in",
        ).toEqual(order);
      }
    });

    it("hands back what retrieval returns: the chunk, its document's title and path, pages and section", async () => {
      const w = world.get();
      const register = await chunkOf(REGISTER);
      const { allowed } = await w.inTenant("kestrel", (tx) => decideChunks(tx, w.user("leo.martin"), [register]));
      expect(allowed[0]).toMatchObject({
        id: register,
        documentId: await w.documentId(REGISTER),
        title: "Contract Register 2026-09-28.pdf",
        path: REGISTER,
        pageStart: 1,
      });
      expect(allowed[0].text).toContain("# Contract register");
      expect(allowed[0]).not.toHaveProperty("allowed");
    });

    it("drops a chunk of an old version without a word: not allowed, not denied", async () => {
      const w = world.get();
      const documentId = await w.documentId(POLICY);
      const [{ id: stale }] = await w.t.sql<{ id: string }[]>`
        INSERT INTO chunks (tenant_id, document_id, document_version, ordinal, text, token_count)
        VALUES (${w.tenants.kestrel}, ${documentId}, 0, 99, 'Meals: up to £35 a day (the old version).', 9)
        RETURNING id`;
      try {
        const result = await w.inTenant("kestrel", (tx) => decideChunks(tx, w.user("leo.martin"), [stale]));
        expect(result, "join each chunk to its document at the document's current version").toEqual({
          allowed: [],
          denied: [],
        });
      } finally {
        await w.t.sql`DELETE FROM chunks WHERE id = ${stale}`;
      }
    });
  });

  describe("on the real corpus", () => {
    it("keeps leo.martin's Heron search inside his 18 documents: 8 chunks back, none from /Exec, nothing to deny", async () => {
      const retrieval = await ask("leo.martin", HERON_QUESTION);
      expect(retrieval.chunks).toHaveLength(8);
      expect(retrieval.chunks.some((chunk) => chunk.path.startsWith("/Exec/"))).toBe(false);
      expect(
        (await audit(retrieval.auditId)).denied,
        "search ran over documents leo can't read, and the decision threw their chunks away afterwards: " +
          "pre-filter by his principals, so the search only looks where he may read",
      ).toEqual([]);
    });

    it("gives daniel.reyes the memo for the same question", async () => {
      const retrieval = await ask("daniel.reyes", HERON_QUESTION);
      expect(retrieval.chunks[0].path).toBe(HERON);
    });

    it("can only over-fetch when the principal set is stale: 60 candidates, 60 denied, nothing returned", async () => {
      const w = world.get();
      const question = "AP batch B-2026-117 invoice hold Brindle Print";
      expect((await ask("leo.martin", question)).chunks).toHaveLength(8);
      // Leo's closure rows go, by hand: nothing bumps the directory version, so the cached set (4 ids) is stale.
      await w.t.sql`DELETE FROM group_closure WHERE member_id = ${w.user("leo.martin")}`;
      try {
        const stale = await ask("leo.martin", question);
        const row = await audit(stale.auditId);
        expect(stale.chunks, "the decision reads the live closure: leo holds nothing now").toEqual([]);
        expect(row.returned).toBe(0);
        expect(
          row.denied,
          "the pre-filter used the set it was given: search looked in his old 18 documents, the decision refused all 60",
        ).toHaveLength(60);
      } finally {
        await w.syncDirectory();
      }
    });

    it("gives peter.hall, disabled, nothing at all", async () => {
      expect((await ask("peter.hall", HERON_QUESTION)).chunks).toEqual([]);
    });
  });
});
