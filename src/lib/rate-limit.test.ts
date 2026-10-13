// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

import { takeToken, type Bucket } from "./rate-limit";

const LEO = "44444444-4444-4444-8444-444444444444";
const NORA = "55555555-5555-4555-8555-555555555555";
const BUCKET: Bucket = { name: "test", capacity: 3, refillPerSecond: 0.5 };
const T0 = new Date("2026-10-13T12:00:00Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

describe.skipIf(!postgresAvailable)("takeToken (a token bucket in Postgres)", () => {
  let t: TestDatabase;
  let tenant: string;

  const take = (userId: string, now: Date, bucket = BUCKET) =>
    withTenantOn(t.appDb, tenant, (tx) => takeToken(tx, { tenantId: tenant, userId }, bucket, now));

  beforeAll(async () => {
    t = await createTestDatabase();
    [{ id: tenant }] = await t.sql`
      INSERT INTO organization (name, slug, created_at) VALUES ('Kestrel Pay', 'kestrel', now()) RETURNING id`;
    for (const [id, name] of [
      [LEO, "leo.martin"],
      [NORA, "nora.kim"],
    ]) {
      await t.sql`INSERT INTO principals (id, tenant_id, kind, external_id, name, display_name, enabled, synced_at)
                  VALUES (${id}, ${tenant}, 'user', ${id}, ${name}, ${name}, true, now())`;
    }
  });

  afterAll(async () => {
    await t?.drop();
  });

  beforeEach(async () => {
    await t.sql`DELETE FROM rate_limit_buckets`;
  });

  it("allows a full bucket's worth, then refuses with the wait until the next token", async () => {
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await take(LEO, T0));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0]);
    // 0.5 tokens a second: the next whole token is 2 s away.
    expect(results[3].retryAfterSeconds).toBe(2);
  });

  it("refills with time, up to the capacity and no further", async () => {
    for (let i = 0; i < 3; i++) await take(LEO, T0);
    expect((await take(LEO, at(1))).allowed).toBe(false);
    expect((await take(LEO, at(2))).allowed).toBe(true);
    const later = await take(LEO, at(3600));
    expect(later).toMatchObject({ allowed: true, remaining: 2 });
  });

  it("keeps a bucket per user", async () => {
    for (let i = 0; i < 3; i++) await take(LEO, T0);
    expect((await take(LEO, T0)).allowed).toBe(false);
    expect((await take(NORA, T0)).allowed).toBe(true);
  });

  it("never lets concurrent requests take more than the bucket holds", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => take(LEO, T0)));
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
  });

  it("ignores a clock that goes backwards instead of refilling or erroring", async () => {
    for (let i = 0; i < 3; i++) await take(LEO, at(10));
    expect((await take(LEO, T0)).allowed).toBe(false);
  });

  it("sees nothing of the bucket outside the tenant (RLS)", async () => {
    await take(LEO, T0);
    const [{ count }] = await t.appDb.$client`SELECT count(*)::int AS count FROM rate_limit_buckets`;
    expect(count).toBe(0);
  });
});
