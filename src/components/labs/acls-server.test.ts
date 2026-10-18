// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { RetrieveDeps } from "#learn/retrieve/retrieve";

import { noRewriter } from "#learn/query/rewrite";
import { overlapReranker } from "#learn/rerank/rerank";
import { setupAclWorld, WORLD_EMBEDDER } from "@/core/acl/testing";
import { withTenantOn } from "@/db/tenant";
import { postgresAvailable } from "@/db/testing";

import { aclLabRun, aclLabUsers } from "./acls-server";

const world = setupAclWorld({ chunks: true });
const HERON = "Project Heron acquisition of Lumen Ledger board vote";

describe.skipIf(!postgresAvailable)("the ACL lab", () => {
  const deps = () => {
    const w = world.get();
    const retrieve: RetrieveDeps = {
      withTenant: (tenantId, fn) => withTenantOn(w.t.appDb, tenantId, fn),
      embedder: WORLD_EMBEDDER,
      reranker: overlapReranker(),
      rewriter: noRewriter,
    };
    return { retrieve, owner: w.t.db };
  };

  it("lists every user of both tenants", async () => {
    const users = await aclLabUsers(world.get().t.db);
    expect(users).toHaveLength(37);
    expect(users.find((user) => user.username === "peter.hall")).toMatchObject({ tenant: "kestrel", enabled: false });
  });

  it("shows leo.martin's groups, his share of the documents, nothing denied, and the audit row", async () => {
    const w = world.get();
    const run = await aclLabRun(deps(), { tenantId: w.tenants.kestrel, userId: w.user("leo.martin") }, HERON);
    expect(run.groups).toEqual([
      { name: "/Kestrel/Finance/AP", depth: 1 },
      { name: "/Kestrel/Finance", depth: 2 },
      { name: "/Kestrel", depth: 3 },
    ]);
    expect(run.documents).toEqual({ total: 40, readable: 18, candidates: 18 });
    expect(run.returned).toHaveLength(8);
    expect(run.returned.some((chunk) => chunk.path.startsWith("/Exec/"))).toBe(false);
    expect(run.denied).toEqual([]);
    expect(run.audit).toMatchObject({ returned: 8, denied: 0 });
    expect(run.walls).toEqual([{ tenant: "harbour", documents: 6, visibleFromHere: 0 }]);
  });

  it("shows what peter.hall's stale groups would have searched, all denied", async () => {
    const w = world.get();
    const run = await aclLabRun(deps(), { tenantId: w.tenants.kestrel, userId: w.user("peter.hall") }, HERON);
    expect(run.user.enabled).toBe(false);
    expect(run.documents).toMatchObject({ readable: 0, candidates: 19 });
    expect(run.returned).toEqual([]);
    expect(run.denied.length).toBe(run.audit.denied);
    expect(run.denied.length).toBeGreaterThan(0);
  });

  it("shows nina.osei Harbour's documents only, with Kestrel's 40 out of sight", async () => {
    const w = world.get();
    const run = await aclLabRun(
      deps(),
      { tenantId: w.tenants.harbour, userId: w.user("nina.osei", "harbour") },
      "What is the hotel limit for a night in London?",
    );
    expect(run.user.tenant).toBe("harbour");
    expect(run.returned.length).toBeGreaterThan(0);
    expect(run.walls).toEqual([{ tenant: "kestrel", documents: 40, visibleFromHere: 0 }]);
  });
});
