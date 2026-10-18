// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { CHAT_BUCKET, takeToken, type Bucket } from "#learn/boundary/rate-limit";
import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

const LEO = "44444444-4444-4444-8444-444444444444";
const NORA = "55555555-5555-4555-8555-555555555555";
const SMALL: Bucket = { name: "test", capacity: 3, refillPerSecond: 0.5 };
const T0 = new Date("2026-10-18T09:00:00Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

describe.skipIf(!postgresAvailable)("the token bucket", () => {
  let t: TestDatabase;
  let tenant: string;

  const take = (userId: string, now: Date, bucket = SMALL) =>
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

  it("starts full: lets a burst of capacity through, then refuses with the wait for the next token", async () => {
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await take(LEO, T0));
    expect(
      results.map((r) => r.allowed),
      "a new bucket starts with capacity tokens",
    ).toEqual([true, true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0]);
    expect(
      results.map((r) => r.retryAfterSeconds),
      "0 when allowed; 0.5 a second makes 2 s to one token",
    ).toEqual([0, 0, 0, 2]);
  });

  it("refills with time, and never past its capacity", async () => {
    for (let i = 0; i < 3; i++) await take(LEO, T0);
    expect((await take(LEO, at(1))).allowed, "half a token after 1 s: not enough").toBe(false);
    expect((await take(LEO, at(2))).allowed, "a whole token after 2 s").toBe(true);
    expect(await take(LEO, at(3600)), "an hour refills 1,800 tokens, capped at 3, minus this one").toMatchObject({
      allowed: true,
      remaining: 2,
    });
  });

  it("counts each second of refill once, refused or not, and rounds the wait up", async () => {
    for (let i = 0; i < 3; i++) await take(LEO, T0);
    expect(await take(LEO, at(0.5)), "a quarter token: 1.5 s to go, so Retry-After 2 (round up)").toEqual({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 2,
    });
    expect((await take(LEO, at(1))).allowed).toBe(false);
    expect(
      (await take(LEO, at(1.5))).allowed,
      "0.75 of a token at 1.5 s: a refusal must move refilled_at on, or its refill is counted again for free",
    ).toBe(false);
    expect(
      (await take(LEO, at(2))).allowed,
      "a whole token at 2 s: each refusal stores what was available, so none of the refill is lost",
    ).toBe(true);
  });

  it("keeps a bucket per user", async () => {
    for (let i = 0; i < 3; i++) await take(LEO, T0);
    expect((await take(LEO, T0)).allowed).toBe(false);
    expect((await take(NORA, T0)).allowed, "Nora has her own bucket").toBe(true);
  });

  it("never lets requests at the same moment take more than the bucket holds", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => take(LEO, T0)));
    expect(
      results.filter((r) => r.allowed).length,
      "12 at once against 3 tokens: read-then-write lets them all see a full bucket. Decide in one UPDATE",
    ).toBe(3);
  });

  it("ignores a clock that goes backwards instead of refilling, refusing wrongly or erroring", async () => {
    for (let i = 0; i < 2; i++) await take(LEO, at(10));
    expect((await take(LEO, T0)).allowed, "one token left: a request stamped earlier still takes it").toBe(true);
    expect((await take(LEO, T0)).allowed, "and finds none after").toBe(false);
    const [row] = await t.sql`SELECT tokens, refilled_at FROM rate_limit_buckets WHERE user_id = ${LEO}`;
    expect(row.tokens, "a negative refill is no refill").toBeGreaterThanOrEqual(0);
    expect(new Date(row.refilled_at).toISOString(), "refilled_at never moves back").toBe(at(10).toISOString());
  });

  it("gives Leo 10 questions at 09:00, one every 6 seconds after, and 9 left a minute later", async () => {
    const burst = [];
    for (let i = 0; i < 11; i++) burst.push(await take(LEO, T0, CHAT_BUCKET));
    expect(burst.map((r) => r.remaining)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0]);
    expect(burst[10], "the 11th: 429, Retry-After 6").toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 6 });
    expect(await take(LEO, at(3), CHAT_BUCKET), "at 09:00:03 half a token: 3 s more").toEqual({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 3,
    });
    expect(await take(LEO, at(6), CHAT_BUCKET)).toEqual({ allowed: true, remaining: 0, retryAfterSeconds: 0 });
    expect(await take(LEO, at(66), CHAT_BUCKET), "60 s refills 10, capped at 10, minus 1").toEqual({
      allowed: true,
      remaining: 9,
      retryAfterSeconds: 0,
    });
    const [row] = await t.sql`SELECT tokens, refilled_at FROM rate_limit_buckets WHERE user_id = ${LEO}`;
    expect([row.tokens, new Date(row.refilled_at).toISOString()]).toEqual([9, "2026-10-18T09:01:06.000Z"]);
  });
});
