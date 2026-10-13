// @vitest-environment node
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createGraphClient } from "#learn/connectors/graph";
import { groupClosure, groupMembers, principals } from "@/db/schema";
import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

import { type Client, setupFakeWorkspace } from "../../../servers/fake-workspace/testing";
import { fetchFrom } from "../connectors/testing";
import { applyDirectory, closureMembers, fetchDirectory } from "./sync";

const fw = setupFakeWorkspace();

describe.skipIf(!postgresAvailable)("directory sync", () => {
  let t: TestDatabase;
  let kestrel: string;
  let harbour: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    [{ id: kestrel }, { id: harbour }] = await t.sql`
      INSERT INTO organization (name, slug, created_at)
      VALUES ('Kestrel Pay', 'kestrel', now()), ('Harbour Health', 'harbour', now())
      RETURNING id`;
  });

  afterAll(async () => {
    await t?.drop();
  });

  const graphFor = (client: Client, site: "kestrel" | "harbour") =>
    createGraphClient({
      baseUrl: "http://fw",
      site,
      token: `dev-workspace-${site}`,
      fetch: fetchFrom(client),
      pageSize: 3,
    });

  async function sync(client: Client, site: "kestrel" | "harbour" = "kestrel") {
    const tenantId = site === "kestrel" ? kestrel : harbour;
    const snapshot = await fetchDirectory(graphFor(client, site));
    return withTenantOn(t.appDb, tenantId, (tx) => applyDirectory(tx, tenantId, snapshot, new Date()));
  }

  const inKestrel = <T>(fn: Parameters<typeof withTenantOn<T>>[2]) => withTenantOn(t.appDb, kestrel, fn);

  it("mirrors users and groups, with a disabled user disabled, and principal ids equal to directory ids", async () => {
    const client = fw.client();
    await t.sql`DELETE FROM group_closure; DELETE FROM group_members; DELETE FROM principals`.simple();
    const result = await sync(client);
    expect(result.principals).toBe(12);

    const rows = await inKestrel((tx) => tx.select().from(principals));
    const peter = rows.find((row) => row.name === "peter.hall")!;
    expect(peter).toMatchObject({ kind: "user", enabled: false, email: "peter.hall@kestrelpay.example" });
    expect(peter.id).toBe(fw.corpus.user("kestrel", "peter.hall"));
    const ap = rows.find((row) => row.name === "/Kestrel/Finance/AP")!;
    expect(ap).toMatchObject({ kind: "group", id: fw.corpus.group("kestrel", "/Kestrel/Finance/AP") });
  });

  it("builds a closure that matches /transitiveMembers for every group", async () => {
    const client = fw.client();
    await sync(client);
    const graph = graphFor(client, "kestrel");
    for (const group of await graph.groups()) {
      const want = (await graph.transitiveMembers(group.id)).map((member) => member.id).sort();
      expect(await inKestrel((tx) => closureMembers(tx, group.id)), group.displayName).toEqual(want);
    }
    const depths = await inKestrel((tx) =>
      tx
        .select({ depth: groupClosure.depth })
        .from(groupClosure)
        .where(eq(groupClosure.memberId, fw.corpus.user("kestrel", "leo.martin"))),
    );
    expect(depths.map((row) => row.depth).sort()).toEqual([1, 2, 3]);
  });

  it("changes nothing on a second run", async () => {
    const client = fw.client();
    await sync(client);
    expect(await sync(client)).toMatchObject({
      disabled: [],
      members: { added: 0, removed: 0 },
      closure: { added: 0, removed: 0, changed: 0 },
    });
  });

  it("drops leo.martin's closure rows when he leaves /Kestrel/Finance/AP, and draws no acl_version", async () => {
    const client = fw.client();
    await sync(client);
    const leo = fw.corpus.user("kestrel", "leo.martin");
    const [before] = await t.sql`SELECT last_value, is_called FROM acl_version_seq`;
    const removed = await client.delete(
      `/_control/sites/kestrel/groups/${fw.corpus.group("kestrel", "/Kestrel/Finance/AP")}/members/${leo}`,
    );
    expect(removed.status).toBe(204);

    const result = await sync(client);
    expect(result).toMatchObject({ members: { added: 0, removed: 1 }, closure: { removed: 3, added: 0 } });
    const rows = await inKestrel((tx) => tx.select().from(groupClosure).where(eq(groupClosure.memberId, leo)));
    expect(rows).toEqual([]);
    expect(await inKestrel((tx) => tx.select().from(groupMembers).where(eq(groupMembers.memberId, leo)))).toEqual([]);
    // He's still a user of the tenant, only in no group.
    const [principal] = await inKestrel((tx) => tx.select().from(principals).where(eq(principals.id, leo)));
    expect(principal.enabled).toBe(true);
    expect(await t.sql`SELECT last_value, is_called FROM acl_version_seq`).toEqual([before]);
  });

  it("keeps each tenant's directory to itself", async () => {
    const client = fw.client();
    await sync(client);
    await sync(client, "harbour");
    const harbourNames = await withTenantOn(t.appDb, harbour, async (tx) =>
      (await tx.select({ name: principals.name }).from(principals)).map((row) => row.name).sort(),
    );
    expect(harbourNames).toEqual(["/Harbour", "nina.osei"]);
    const [{ n }] = await t.appDb.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM principals`);
    expect(n).toBe(0);
  });
});
