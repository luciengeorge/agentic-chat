// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";

import type { Tx } from "@/db/tenant";

import {
  bumpDirectoryVersion,
  cachedPrincipals,
  createPrincipalCache,
  directoryVersion,
} from "#learn/acl/principal-cache";
import { candidateDocuments, canRead, viewerPrincipals } from "#learn/retrieve/acl";
import { setupAclWorld } from "@/core/acl/testing";
import { postgresAvailable } from "@/db/testing";

const world = setupAclWorld();
const AP = "/Kestrel/Finance/AP";
const INVOICES = "/Finance/AP/AP Batch B-2026-117 Scanned Invoices.pdf";

describe.skipIf(!postgresAvailable)("the principal cache", () => {
  const live = (tx: Tx, userId: string) => viewerPrincipals(tx, userId, null).then((set) => set.principalIds);
  const counting = () => {
    const counter = {
      loads: 0,
      load: async (tx: Tx, userId: string) => {
        counter.loads += 1;
        return live(tx, userId);
      },
    };
    return counter;
  };
  const membership = () => `/sites/kestrel/groups/${world.get().group(AP)}/members`;
  const removeLeoFromAp = () => world.get().control("DELETE", `${membership()}/${world.get().user("leo.martin")}`);
  /** What a test changed, put back after it, so each test starts from the real directory. */
  let leoRemoved = false;
  let closureDeleted = false;

  afterEach(async () => {
    if (leoRemoved) await world.get().control("POST", membership(), { member_id: world.get().user("leo.martin") });
    if (leoRemoved || closureDeleted) await world.get().syncDirectory();
    leoRemoved = false;
    closureDeleted = false;
  });

  it("reads leo.martin's 4 principals once, then hands back the same set while the directory version holds", async () => {
    const w = world.get();
    const leo = w.user("leo.martin");
    const cache = createPrincipalCache();
    const counter = counting();
    const ask = () => w.inTenant("kestrel", (tx) => cachedPrincipals(tx, leo, cache, counter.load));
    const first = await ask();
    expect([...first].sort()).toEqual([leo, w.group(AP), w.group("/Kestrel/Finance"), w.group("/Kestrel")].sort());
    expect(await ask()).toEqual(first);
    expect(counter.loads, "the second request must come from the cache").toBe(1);
  });

  it("loads again on the first request after a sync that changes a membership: leo's 18 candidates drop to 0", async () => {
    const w = world.get();
    const leo = w.user("leo.martin");
    const cache = createPrincipalCache();
    const counter = counting();
    const request = () =>
      w.inTenant("kestrel", async (tx) => {
        const principalIds = await cachedPrincipals(tx, leo, cache, counter.load);
        return { principalIds, candidates: (await candidateDocuments(tx, principalIds)).length };
      });
    expect((await request()).candidates).toBe(18);
    await request();
    expect(counter.loads).toBe(1);

    await removeLeoFromAp();
    leoRemoved = true;
    const result = await w.syncDirectory();
    expect(result.closure.removed, "AP, Finance and Kestrel: his 3 closure rows").toBe(3);
    expect(await request(), "the sync bumped the version: load the new set").toEqual({
      principalIds: [leo],
      candidates: 0,
    });
    expect(counter.loads).toBe(2);
  });

  it("keeps the entry through a sync that changes nothing", async () => {
    const w = world.get();
    const cache = createPrincipalCache();
    const counter = counting();
    const ask = () => w.inTenant("kestrel", (tx) => cachedPrincipals(tx, w.user("leo.martin"), cache, counter.load));
    await ask();
    const before = await w.inTenant("kestrel", directoryVersion);
    await w.syncDirectory();
    expect(await w.inTenant("kestrel", directoryVersion)).toEqual(before);
    await ask();
    expect(counter.loads, "same version, same set: no reload").toBe(1);
  });

  it("reads the version before it loads, so a sync landing mid-load can't file the old set under the new version", async () => {
    const w = world.get();
    const leo = w.user("leo.martin");
    const cache = createPrincipalCache();
    let synced = false;
    const racing = async (tx: Tx, userId: string) => {
      const set = await live(tx, userId);
      if (!synced) {
        // The set is read. Now a sync on another connection removes leo from AP and commits, before we store it.
        synced = true;
        await removeLeoFromAp();
        leoRemoved = true;
        await w.syncDirectory();
      }
      return set;
    };
    const ask = () => w.inTenant("kestrel", (tx) => cachedPrincipals(tx, leo, cache, racing));
    expect(await ask(), "the first request still sees the set it read").toHaveLength(4);
    expect(
      await ask(),
      "the entry was stored under the version read after the load: read the version before, and key the entry by that",
    ).toEqual([leo]);
  });

  it("keeps each tenant's entries apart, even at the same version", async () => {
    const w = world.get();
    const cache = createPrincipalCache();
    const id = w.user("leo.martin");
    const tenantOf = async (tx: Tx) => (await directoryVersion(tx)).tenantId!;
    const load = async (tx: Tx) => [await tenantOf(tx)];
    const versions = async () => ({
      kestrel: (await w.inTenant("kestrel", directoryVersion)).version,
      harbour: (await w.inTenant("harbour", directoryVersion)).version,
    });
    let { kestrel, harbour } = await versions();
    while (harbour < kestrel)
      harbour = await w.inTenant("harbour", (tx) => bumpDirectoryVersion(tx, w.tenants.harbour));
    while (kestrel < harbour)
      kestrel = await w.inTenant("kestrel", (tx) => bumpDirectoryVersion(tx, w.tenants.kestrel));

    expect(await w.inTenant("kestrel", (tx) => cachedPrincipals(tx, id, cache, load))).toEqual([w.tenants.kestrel]);
    expect(
      await w.inTenant("harbour", (tx) => cachedPrincipals(tx, id, cache, load)),
      "keyed by user alone, a set read in Kestrel came back in Harbour: key by tenant and user",
    ).toEqual([w.tenants.harbour]);
  });

  it("caches nothing outside withTenant, where there's no tenant to key by", async () => {
    const w = world.get();
    const cache = createPrincipalCache();
    const counter = counting();
    const fake = async () => {
      counter.loads += 1;
      return ["x"];
    };
    await w.t.appDb.transaction((tx) => cachedPrincipals(tx, w.user("leo.martin"), cache, fake));
    await w.t.appDb.transaction((tx) => cachedPrincipals(tx, w.user("leo.martin"), cache, fake));
    expect(counter.loads, "with no tenant there's no key: load, and store nothing").toBe(2);
  });

  it("can only over-fetch when stale: with leo's closure deleted by hand, the old set finds AP's invoices, and readable() refuses them", async () => {
    const w = world.get();
    const leo = w.user("leo.martin");
    const cache = createPrincipalCache();
    const invoices = await w.documentId(INVOICES);
    await w.inTenant("kestrel", (tx) => viewerPrincipals(tx, leo, cache));
    // No sync, so nothing bumps the version: the cached set is now stale.
    await w.t.sql`DELETE FROM group_closure WHERE member_id = ${leo}`;
    closureDeleted = true;

    const seen = await w.inTenant("kestrel", async (tx) => {
      const { principalIds } = await viewerPrincipals(tx, leo, cache);
      return {
        principals: principalIds.length,
        candidates: await candidateDocuments(tx, principalIds),
        allowed: await canRead(tx, leo, invoices),
      };
    });
    expect(seen.principals, "the stale set still holds AP, Finance and Kestrel").toBe(4);
    expect(seen.candidates).toHaveLength(18);
    expect(seen.candidates).toContain(invoices);
    expect(seen.allowed, "the decision reads the live closure").toBe(false);
  });
});
