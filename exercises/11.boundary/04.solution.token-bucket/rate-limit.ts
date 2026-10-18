/** Rate limiting (section 11.4): a token bucket per user, kept in Postgres so every server process shares it. */
import { sql } from "drizzle-orm";

import type { Tx } from "@/db/tenant";

/** A token bucket: it holds up to `capacity` tokens, gains `refillPerSecond`, and each request takes one. */
export interface Bucket {
  name: string;
  capacity: number;
  refillPerSecond: number;
}

/** Ten questions in a burst, then one every six seconds. */
export const CHAT_BUCKET: Bucket = { name: "chat", capacity: 10, refillPerSecond: 10 / 60 };

export interface RateLimitResult {
  allowed: boolean;
  /** Whole tokens left after this request. */
  remaining: number;
  /** When refused, the wait until a token is back; 0 when allowed. */
  retryAfterSeconds: number;
}

/**
 * What the caller is told, from the bucket after the UPDATE: `tokens` it now holds and whether this request took
 * `cost`. Floating point leaves 2.9999999 for 3, hence the 1e-9 either way.
 */
export function bucketResult(
  { tokens, allowed }: { tokens: number; allowed: boolean },
  bucket: Bucket,
  cost = 1,
): RateLimitResult {
  return {
    allowed,
    remaining: Math.floor(tokens + 1e-9),
    retryAfterSeconds: allowed ? 0 : Math.ceil((cost - tokens) / bucket.refillPerSecond - 1e-9),
  };
}

/**
 * Takes one token from a user's bucket, inside the caller's tenant transaction. The bucket is a row:
 * the first statement makes it full if it's missing, and the second refills it by the time since `refilled_at`
 * and takes a token if one is there. The UPDATE locks the row, so concurrent requests take turns. `now` comes from
 * the caller (a clock the tests control); a time before `refilled_at` refills nothing.
 */
export async function takeToken(
  tx: Tx,
  viewer: { tenantId: string; userId: string },
  bucket: Bucket,
  now: Date,
  cost = 1,
): Promise<RateLimitResult> {
  const nowIso = now.toISOString();
  await tx.execute(sql`
    INSERT INTO rate_limit_buckets (tenant_id, user_id, bucket, tokens, refilled_at)
    VALUES (${viewer.tenantId}, ${viewer.userId}, ${bucket.name}, ${bucket.capacity}, ${nowIso})
    ON CONFLICT (tenant_id, user_id, bucket) DO NOTHING`);

  // `row` is the table in SET and `old` in RETURNING (Postgres 18), so both read the bucket before this request.
  const available = (row: "rate_limit_buckets" | "old") => sql`LEAST(${bucket.capacity}::float8,
    ${sql.raw(row)}.tokens + GREATEST(0, EXTRACT(EPOCH FROM (${nowIso}::timestamptz - ${sql.raw(row)}.refilled_at)))
      * ${bucket.refillPerSecond}::float8)`;
  const rows = await tx.execute(sql`
    UPDATE rate_limit_buckets
    SET tokens = CASE WHEN ${available("rate_limit_buckets")} >= ${cost}
                      THEN ${available("rate_limit_buckets")} - ${cost}
                      ELSE ${available("rate_limit_buckets")} END,
        refilled_at = GREATEST(refilled_at, ${nowIso}::timestamptz)
    WHERE tenant_id = ${viewer.tenantId} AND user_id = ${viewer.userId} AND bucket = ${bucket.name}
    RETURNING new.tokens AS tokens, ${available("old")} >= ${cost} AS allowed`);
  const [row] = rows as unknown as Array<{ tokens: number; allowed: boolean }>;
  return bucketResult(row, bucket, cost);
}
