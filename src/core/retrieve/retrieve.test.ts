// @vitest-environment node

import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Embedder } from "#learn/embed/embed";
import type { Reranker } from "#learn/rerank/rerank";

import { hashingEmbedder } from "#learn/embed/fake";
import { noRewriter } from "#learn/query/rewrite";
import { overlapReranker } from "#learn/rerank/rerank";
import { lexicalSearch } from "#learn/search/lexical";
import { vectorSearch } from "#learn/search/vector";
import { chunks, documentAcl, documents, groupClosure, principals, retrievalAudit } from "@/db/schema";
import { type Tx, withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

import type { Viewer } from "./types";

import { canRead, readable, UnknownViewerError } from "./acl";
import { createRetrieve, queryHash, type RetrieveDeps } from "./retrieve";

const DIMENSIONS = 1536;
const embedder = hashingEmbedder(DIMENSIONS);

const id = () => randomUUID();

const P = {
  kestrel: id(),
  harbour: id(),
  // Kestrel's directory
  gKestrel: id(),
  gExec: id(),
  gFinance: id(),
  gAP: id(),
  gEngineering: id(),
  gLegacy: id(),
  leo: id(),
  daniel: id(),
  peter: id(),
  sam: id(),
  // Harbour's
  gHarbour: id(),
  nina: id(),
};

const D = {
  heron: id(),
  expenses: id(),
  register: id(),
  catalogue: id(),
  legacy: id(),
  denied: id(),
  harbourExpenses: id(),
  draft: id(),
};

describe.skipIf(!postgresAvailable)("retrieve", () => {
  let t: TestDatabase;
  let deps: RetrieveDeps;
  const tenantOf = (userId: string) => (userId === P.nina ? P.harbour : P.kestrel);
  const viewer = (userId: string): Viewer => ({ tenantId: tenantOf(userId), userId });

  async function addDocument(
    tenantId: string,
    documentId: string,
    title: string,
    path: string,
    texts: string[],
    grants: { principalId: string; effect?: "allow" | "deny" }[],
    options: { status?: string; vectors?: Embedder } = {},
  ) {
    const [{ version }] = await t.db.execute<{ version: string }>(sql`SELECT nextval('acl_version_seq') AS version`);
    const aclVersion = Number(version);
    await t.db.insert(documents).values({
      id: documentId,
      tenantId,
      source: "test",
      externalId: documentId,
      title,
      path,
      mimeType: "text/markdown",
      version: 1,
      sourceVersion: "1",
      contentHash: documentId,
      status: options.status ?? "ready",
      aclVersion,
    });
    if (grants.length) {
      await t.db.insert(documentAcl).values(
        grants.map((grant) => ({
          tenantId,
          documentId,
          principalId: grant.principalId,
          effect: grant.effect ?? "allow",
          aclVersion,
        })),
      );
    }
    const vectors = await (options.vectors ?? embedder).embed(texts);
    await t.db.insert(chunks).values(
      texts.map((text, ordinal) => ({
        tenantId,
        documentId,
        documentVersion: 1,
        ordinal,
        text,
        section: null,
        tokenCount: text.split(" ").length,
        embedding: vectors[ordinal],
        embeddingModelVersion: embedder.version,
      })),
    );
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    await t.sql`
      INSERT INTO organization (id, name, slug, created_at)
      VALUES (${P.kestrel}, 'Kestrel Pay', 'kestrel', now()), (${P.harbour}, 'Harbour Health', 'harbour', now())`;

    const principal = (tenantId: string, principalId: string, kind: string, name: string, enabled = true) => ({
      id: principalId,
      tenantId,
      kind,
      externalId: principalId,
      name,
      displayName: name,
      enabled,
      syncedAt: new Date(),
    });
    await t.db.insert(principals).values([
      principal(P.kestrel, P.gKestrel, "group", "/Kestrel"),
      principal(P.kestrel, P.gExec, "group", "/Kestrel/Exec"),
      principal(P.kestrel, P.gFinance, "group", "/Kestrel/Finance"),
      principal(P.kestrel, P.gAP, "group", "/Kestrel/Finance/AP"),
      principal(P.kestrel, P.gEngineering, "group", "/Kestrel/Engineering"),
      // A group the directory stopped listing: disabled, never deleted. It still has members and grants.
      principal(P.kestrel, P.gLegacy, "group", "/Kestrel/Legacy", false),
      principal(P.kestrel, P.leo, "user", "leo.martin"),
      principal(P.kestrel, P.daniel, "user", "daniel.reyes"),
      principal(P.kestrel, P.peter, "user", "peter.hall", false),
      principal(P.kestrel, P.sam, "user", "sam.patel"),
      principal(P.harbour, P.gHarbour, "group", "/Harbour"),
      principal(P.harbour, P.nina, "user", "nina.osei"),
    ]);
    const closure = (tenantId: string, groupId: string, memberId: string, depth = 1) => ({
      tenantId,
      groupId,
      memberId,
      depth,
    });
    await t.db.insert(groupClosure).values([
      // leo: AP, so Finance and Kestrel through nesting; and the disabled Legacy group
      closure(P.kestrel, P.gAP, P.leo),
      closure(P.kestrel, P.gFinance, P.leo, 2),
      closure(P.kestrel, P.gKestrel, P.leo, 3),
      closure(P.kestrel, P.gLegacy, P.leo),
      // daniel: Exec and Finance
      closure(P.kestrel, P.gExec, P.daniel),
      closure(P.kestrel, P.gFinance, P.daniel),
      closure(P.kestrel, P.gKestrel, P.daniel, 2),
      // peter: left the company, still listed in Finance
      closure(P.kestrel, P.gFinance, P.peter),
      closure(P.kestrel, P.gKestrel, P.peter, 2),
      // sam: Engineering
      closure(P.kestrel, P.gEngineering, P.sam),
      closure(P.kestrel, P.gKestrel, P.sam, 2),
      closure(P.kestrel, P.gFinance, P.gAP),
      closure(P.kestrel, P.gKestrel, P.gAP, 2),
      closure(P.harbour, P.gHarbour, P.nina),
    ]);

    // The register's and the catalogue's vectors know nothing of identifiers: they're embedded with every
    // identifier taken out of the text. Only BM25 can find a contract number or an error code in them.
    const blind: Embedder = {
      ...embedder,
      embed: (values) => embedder.embed(values.map((value) => value.replace(/\b[A-Z]{2,}-[\w-]+/g, ""))),
    };

    await addDocument(
      P.kestrel,
      D.heron,
      "Project Heron Board Memo.pdf",
      "/Exec/Project Heron Board Memo.pdf",
      ["Project Heron: the proposed acquisition of Lumen Ledger at an indicative £86m. The board votes on 2026-10-20."],
      [{ principalId: P.gExec }],
    );
    await addDocument(
      P.kestrel,
      D.expenses,
      "Travel and Expenses Policy v2.pdf",
      "/HR/Policies/Travel and Expenses Policy v2.pdf",
      [
        "Expenses: meals are allowed up to £40 a day and London hotels up to £200 a night.",
        "Receipts are needed for any expense above £25.",
      ],
      [{ principalId: P.gKestrel }],
    );
    await addDocument(
      P.kestrel,
      D.register,
      "Contract Register 2026-09-28.pdf",
      "/Legal/Contracts/Contract Register 2026-09-28.pdf",
      [
        "| KPC-2026-0142 | Ashgrove | Master services agreement | Legal | 2026-03-01 |",
        "| KPC-2025-0231 | Sorrel Identity | Data processing agreement | Legal | 2025-06-01 |",
      ],
      [{ principalId: P.gFinance }],
      { vectors: blind },
    );
    await addDocument(
      P.kestrel,
      D.catalogue,
      "Payments API Error Code Catalogue.pdf",
      "/Engineering/Runbooks/Payments API Error Code Catalogue.pdf",
      ["KP-4031: the payout was rejected because the beneficiary account is closed. Retry with a new account."],
      [{ principalId: P.gEngineering }, { principalId: P.gFinance }],
      { vectors: blind },
    );
    await addDocument(
      P.kestrel,
      D.legacy,
      "Legacy Expenses Notes.md",
      "/Legacy/Legacy Expenses Notes.md",
      ["Legacy expenses notes: meals allowed up to £35 a day under the old policy."],
      [{ principalId: P.gLegacy }],
    );
    await addDocument(
      P.kestrel,
      D.denied,
      "AP Expenses Exceptions.md",
      "/Finance/AP Expenses Exceptions.md",
      ["AP expenses exceptions: hotels above the London limit need the controller's approval."],
      [{ principalId: P.gFinance }, { principalId: P.leo, effect: "deny" }],
    );
    await addDocument(
      P.kestrel,
      D.draft,
      "Expenses Draft.md",
      "/Finance/Expenses Draft.md",
      ["Draft expenses rules: meals and hotels, being rewritten."],
      [{ principalId: P.gKestrel }],
      { status: "ingesting" },
    );
    await addDocument(
      P.harbour,
      D.harbourExpenses,
      "Travel and Expenses Policy.pdf",
      "/Policies/Travel and Expenses Policy.pdf",
      ["Harbour expenses: meals are allowed up to £25 a day and hotels up to £150 a night."],
      [{ principalId: P.gHarbour }],
    );

    deps = {
      withTenant: <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) => withTenantOn(t.appDb, tenantId, fn),
      embedder,
      reranker: overlapReranker(),
      rewriter: noRewriter,
    };
  });

  afterAll(async () => {
    await t?.drop();
  });

  const documentsOf = (retrieval: { chunks: { documentId: string }[] }) =>
    new Set(retrieval.chunks.map((chunk) => chunk.documentId));

  describe("identifiers", () => {
    it("BM25 ranks the contract number first while the vectors miss it", async () => {
      const query = "What are the terms of contract KPC-2026-0142?";
      const [vector] = await embedder.embed([query]);
      const allDocs = Object.values(D);
      const { lexical, nearest } = await withTenantOn(t.appDb, P.kestrel, async (tx) => ({
        lexical: await lexicalSearch(tx, query, { documentIds: allDocs, limit: 5 }),
        nearest: await vectorSearch(tx, vector, { documentIds: allDocs, modelVersion: embedder.version, limit: 2 }),
      }));
      const textOf = async (chunkId: string) =>
        (await t.sql`SELECT text FROM chunks WHERE id = ${chunkId}`)[0].text as string;

      expect(await textOf(lexical[0].id)).toContain("KPC-2026-0142");
      for (const hit of nearest) expect(await textOf(hit.id)).not.toContain("KPC-2026-0142");
    });

    it("retrieve returns the contract number's chunk first", async () => {
      const retrieval = await createRetrieve(deps)(viewer(P.leo), "What are the terms of contract KPC-2026-0142?");
      expect(retrieval.chunks[0].text).toContain("KPC-2026-0142");
      expect(retrieval.chunks[0]).toMatchObject({
        documentId: D.register,
        title: "Contract Register 2026-09-28.pdf",
        path: "/Legal/Contracts/Contract Register 2026-09-28.pdf",
        pageStart: null,
        pageEnd: null,
      });
    });

    it("retrieve returns the error code's chunk first", async () => {
      const retrieval = await createRetrieve(deps)(viewer(P.sam), "what does KP-4031 mean");
      expect(retrieval.chunks[0].text).toContain("KP-4031");
    });
  });

  describe("ACLs", () => {
    const heronQuery = "Project Heron acquisition of Lumen Ledger board vote";

    it("never gives leo.martin the Heron memo", async () => {
      const retrieval = await createRetrieve(deps, { k: 50 })(viewer(P.leo), heronQuery);
      expect(documentsOf(retrieval).has(D.heron)).toBe(false);
      await withTenantOn(t.appDb, P.kestrel, async (tx) => expect(await canRead(tx, P.leo, D.heron)).toBe(false));
    });

    it("gives daniel.reyes the Heron memo", async () => {
      const retrieval = await createRetrieve(deps)(viewer(P.daniel), heronQuery);
      expect(retrieval.chunks[0].documentId).toBe(D.heron);
      await withTenantOn(t.appDb, P.kestrel, async (tx) => expect(await canRead(tx, P.daniel, D.heron)).toBe(true));
    });

    it("reaches documents through nested groups", async () => {
      // leo is in AP; the policy is shared with /Kestrel, two levels up.
      const retrieval = await createRetrieve(deps)(viewer(P.leo), "London hotel limit per night");
      expect(documentsOf(retrieval).has(D.expenses)).toBe(true);
    });

    it("gives peter.hall, disabled, nothing, and records what it denied", async () => {
      const retrieval = await createRetrieve(deps)(viewer(P.peter), "expenses hotels meals contract");
      expect(retrieval.chunks).toEqual([]);
      const [audit] = await t.db
        .select()
        .from(retrievalAudit)
        .where(sql`id = ${retrieval.auditId}`);
      expect(audit.returnedIds).toEqual([]);
      expect(audit.deniedIds.length).toBeGreaterThan(0);
    });

    it("never gives a Harbour user a Kestrel chunk", async () => {
      const retrieval = await createRetrieve(deps, { k: 50 })(viewer(P.nina), "expenses meals hotels London limit");
      expect([...documentsOf(retrieval)]).toEqual([D.harbourExpenses]);
    });

    it("refuses a viewer whose user isn't a principal of the tenant", async () => {
      // leo's id with Harbour's tenant: RLS hides Kestrel's principals, so leo doesn't exist there.
      const error = await createRetrieve(deps)({ tenantId: P.harbour, userId: P.leo }, "expenses").catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(UnknownViewerError);
    });

    it("denies a grant through a disabled group, and a document with a deny row, and records both", async () => {
      const retrieval = await createRetrieve(deps, { k: 50 })(
        viewer(P.leo),
        "expenses meals hotels London limit legacy exceptions",
      );
      const found = documentsOf(retrieval);
      expect(found.has(D.expenses)).toBe(true);
      expect(found.has(D.legacy)).toBe(false);
      expect(found.has(D.denied)).toBe(false);

      const deniedDocs = await t.sql`
        SELECT DISTINCT c.document_id FROM retrieval_audit a, unnest(a.denied_ids) AS denied(id)
        JOIN chunks c ON c.id = denied.id WHERE a.id = ${retrieval.auditId}`;
      expect(deniedDocs.map((row) => row.document_id).sort()).toEqual([D.legacy, D.denied].sort());
      await withTenantOn(t.appDb, P.kestrel, async (tx) => {
        expect(await canRead(tx, P.leo, D.denied)).toBe(false);
        expect(await canRead(tx, P.leo, D.legacy)).toBe(false);
        expect(await canRead(tx, P.leo, D.expenses)).toBe(true);
      });
    });

    it("leaves out a document that isn't ready", async () => {
      const retrieval = await createRetrieve(deps, { k: 50 })(viewer(P.leo), "draft expenses rules being rewritten");
      expect(documentsOf(retrieval).has(D.draft)).toBe(false);
      await withTenantOn(t.appDb, P.kestrel, async (tx) => expect(await canRead(tx, P.leo, D.draft)).toBe(false));
    });

    it("decides the same whatever alias the calling query gives its tables", async () => {
      // A caller that names documents `d` or the ACL `a` must not capture readable()'s own subqueries.
      const rows = await withTenantOn(t.appDb, P.kestrel, (tx) =>
        tx.execute<{ id: string; allowed: boolean }>(
          sql`SELECT d.id, ${readable(P.leo, sql`d.id`)} AS allowed FROM documents d WHERE d.id IN (${D.draft}, ${D.heron})`,
        ),
      );
      expect(rows.map((r) => r.allowed)).toEqual([false, false]);
    });
  });

  describe("the audit", () => {
    beforeEach(async () => {
      // Another ACL change somewhere: the mark must be read after the query, so it includes this one.
      await t.db.execute(sql`SELECT nextval('acl_version_seq')`);
    });

    it("writes one row per call: the viewer, a hash of the query, what was returned and the acl_version mark", async () => {
      const query = "London hotel limit per night";
      const retrieval = await createRetrieve(deps, { k: 2 })(viewer(P.leo), query);
      const [{ last }] = await t.sql`SELECT last_value AS last FROM acl_version_seq`;

      const [audit] = await t.db
        .select()
        .from(retrievalAudit)
        .where(sql`id = ${retrieval.auditId}`);
      expect(audit).toMatchObject({
        tenantId: P.kestrel,
        userId: P.leo,
        queryHash: queryHash(query),
        returnedIds: retrieval.chunks.map((chunk) => chunk.id),
        aclVersion: Number(last),
      });
      expect(retrieval.chunks).toHaveLength(2);
    });

    it("is written by the app role, inside the tenant", async () => {
      const retrieval = await createRetrieve(deps)(viewer(P.nina), "hotels");
      const [row] = await withTenantOn(t.appDb, P.harbour, (tx) =>
        tx
          .select()
          .from(retrievalAudit)
          .where(sql`id = ${retrieval.auditId}`),
      );
      expect(row.tenantId).toBe(P.harbour);
      expect(await t.appDb.select().from(retrievalAudit)).toEqual([]);
    });
  });

  describe("query rewriting", () => {
    it("searches the rewrites too and reports them", async () => {
      const retrieve = createRetrieve({ ...deps, rewriter: async () => ["KPC-2025-0231"] }, { k: 50 });
      const retrieval = await retrieve(viewer(P.leo), "Which data processing agreement do we have with Sorrel?");
      expect(retrieval.rewritten).toEqual(["KPC-2025-0231"]);
      expect(retrieval.chunks.some((chunk) => chunk.text.includes("KPC-2025-0231"))).toBe(true);
    });
  });

  describe("options, off by default", () => {
    // Keeps the fused order, so a test can see what fusion did.
    const identity: Reranker = {
      name: "identity",
      rerank: async (_query, documents, topN) =>
        documents.map((_, index) => ({ index, score: 1 - index / 100 })).slice(0, topN),
    };

    it("adds nothing to the result when they're off", async () => {
      const retrieval = await createRetrieve(deps)(viewer(P.leo), "London hotel limit per night");
      expect(retrieval).not.toHaveProperty("hypothetical");
      expect(retrieval).not.toHaveProperty("routedDocumentIds");
    });

    it("HyDE searches the model's passage too: a question in other words finds the policy first", async () => {
      const asked: string[] = [];
      const passage = "Expenses: meals are allowed up to £40 a day and London hotels up to £200 a night.";
      const retrieve = createRetrieve(
        {
          ...deps,
          reranker: identity,
          hyde: async (question) => {
            asked.push(question);
            return passage;
          },
        },
        { k: 50 },
      );
      const retrieval = await retrieve(viewer(P.leo), "How generous is the subsistence allowance?");
      expect(asked).toEqual(["How generous is the subsistence allowance?"]);
      expect(retrieval.hypothetical).toBe(passage);
      expect(retrieval.chunks[0].text).toBe(passage);
    });

    it("routing searches chunks of the routed documents only", async () => {
      const retrieval = await createRetrieve(deps, { k: 50, routeDocuments: 1 })(
        viewer(P.leo),
        "Travel and expenses policy: London hotel limit per night",
      );
      expect(retrieval.routedDocumentIds).toEqual([D.expenses]);
      expect([...documentsOf(retrieval)]).toEqual([D.expenses]);
    });

    it("routing never considers a document the viewer can't read", async () => {
      const retrieval = await createRetrieve(deps, { k: 50, routeDocuments: 20 })(
        viewer(P.leo),
        "Project Heron memo, legacy expenses notes, AP expenses exceptions",
      );
      const routed = new Set(retrieval.routedDocumentIds);
      // The pre-filter lets the legacy notes (a disabled group's grant) and the exceptions (a deny row) through;
      // routing applies the decision itself.
      for (const hidden of [D.heron, D.legacy, D.denied, D.draft, D.harbourExpenses])
        expect(routed.has(hidden)).toBe(false);
      expect(routed.has(D.expenses)).toBe(true);
    });

    it("searches the lexical field it's given, and refuses a name that isn't one", async () => {
      const retrieval = await createRetrieve(deps, { lexicalField: "text" })(viewer(P.leo), "London hotel limit");
      expect(retrieval.chunks.length).toBeGreaterThan(0);
      await expect(createRetrieve(deps, { lexicalField: "text; --" })(viewer(P.leo), "hotel")).rejects.toThrow(
        RangeError,
      );
    });
  });

  describe("input", () => {
    it("refuses an empty query and a k out of range", async () => {
      const retrieve = createRetrieve(deps);
      await expect(retrieve(viewer(P.leo), "   ")).rejects.toThrow(RangeError);
      await expect(retrieve(viewer(P.leo), "q", { k: 0 })).rejects.toThrow(RangeError);
      await expect(retrieve(viewer(P.leo), "q", { k: 51 })).rejects.toThrow(RangeError);
    });
  });
});
