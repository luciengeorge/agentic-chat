// 👨‍💼 Every question Leo asks costs Kestrel a retrieval, a rerank and a model call. A script that loops on
//    `POST /api/chat`, or a stuck retry in his browser, could ask hundreds a minute. The chat lets anyone ask 10 in
//    a burst, then one every 6 seconds. This file counts.

/** Rate limiting (section 11.4): a token bucket per user, kept in Postgres so every server process shares it. */
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
  // 🐨 Start here: it's plain arithmetic, and its tests run without the database. `remaining` is the whole tokens
  //    left, rounded down. `retryAfterSeconds` is 0 when allowed; when refused, it's how long the bucket takes to
  //    refill from `tokens` up to `cost`, in whole seconds, rounded up (Retry-After takes whole seconds, and
  //    rounding down would send Leo back a moment too soon).
  //
  // 💰 `Math.floor`, `Math.ceil`. Add `1e-9` before the floor and take it off before the ceil, so 2.9999999 counts
  //    as 3 and 6.0000001 as 6.
  //
  // 🦉 Worked through. The chat bucket gains 1/6 of a token a second. Refused with 0.5 tokens left, Leo needs 0.5
  //    more: 0.5 ÷ (1/6) = 3 seconds. With 0.25 of a token in a bucket that gains 0.5 a second, 0.75 more takes
  //    1.5 s, and Retry-After says 2.
  throw new Error(`bucketResult(${tokens}, ${allowed}, ${bucket.name}, cost ${cost}) isn't written yet`);
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
  // 🐨 First statement: make sure the bucket row exists. Insert it full (`capacity` tokens, refilled at `now`) for this
  //    tenant, user and bucket name, and do nothing if it's already there.
  // 🐨 Second statement: one UPDATE of that row that does everything at once. The tokens available are what's
  //    stored plus the refill since `refilled_at` (seconds since, never below 0, times `refillPerSecond`), capped at
  //    `capacity`. If that's at least `cost`, store it minus `cost`; if not, store it as it is. Move `refilled_at`
  //    to `now`, unless it's already later. Return enough to say whether the token was taken.
  // 🐨 Hand the returned row (the tokens after, and whether this request took `cost`) to `bucketResult`.
  // 🐨 The classic mistake: SELECT the tokens, decide in JavaScript, then UPDATE. Two requests at once both read 3,
  //    both decide yes, both write 2.
  //
  // 💰 Add `import { sql } from "drizzle-orm"`. `await tx.execute(sql\`...\`)` with `${value}` placeholders.
  //    `INSERT ... ON CONFLICT (tenant_id, user_id, bucket) DO NOTHING`. `LEAST`, `GREATEST`,
  //    `EXTRACT(EPOCH FROM (a - b))` (seconds), `${iso}::timestamptz`, `${n}::float8`. The UPDATE's shape, with
  //    <available> the expression from the 🐨 above:
  //
  //      UPDATE rate_limit_buckets
  //      SET tokens = CASE WHEN <available> >= ${cost} THEN ... ELSE ... END,
  //          refilled_at = ...
  //      WHERE <this tenant, user and bucket>
  //      RETURNING ...
  //
  //    In SET, a column name reads the row before the UPDATE. In RETURNING, Postgres 18's `old.tokens` and
  //    `new.tokens` read the row before and after. <available> appears more than once: a small function that
  //    returns the `sql` fragment, given the table name to read from (`sql.raw("old")`), saves writing it out each
  //    time.
  //
  // 🦉 How a token bucket works. Leo's bucket holds up to 10 tokens and gains one every 6 seconds; each question
  //    takes one. A burst of 10 goes straight through, and after that he gets one every 6 seconds, however fast he
  //    asks. The bucket never stores "a refill every 6 s" as a timer: it stores the tokens and when they were
  //    counted, and works the refill out from the clock when the next request comes. An idle bucket costs nothing.
  // 🦉 Why one UPDATE. Postgres locks a row for the UPDATE that changes it, and a second UPDATE of the same row
  //    waits for the first to commit, then reads the row as the first left it. So when twelve of Leo's requests
  //    arrive at once, they take turns on his row, each seeing the tokens the one before left. A SELECT doesn't
  //    lock; read-then-write lets all twelve see the same full bucket.
  // 🦉 Why in Postgres at all. The app may run on several servers (Vercel runs as many as traffic needs). A counter
  //    in one server's memory would give Leo 10 questions per server. The row is the one place every server sees.
  // 🦉 Why `refilled_at` moves on a refusal too. The refill since it is already counted into what's stored. Leave
  //    it behind and the next request counts those seconds again, and Leo gets tokens for free.
  // 🦉 Why GREATEST(refilled_at, now). Two servers' clocks differ a little. A request stamped a moment earlier than
  //    the last one mustn't move the stamp back (and count refill twice) or refill a negative amount.
  //
  // 📜 https://www.postgresql.org/docs/current/sql-update.html (RETURNING old and new)
  // 📜 https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS
  //
  // 🚨 The tests check `bucketResult`'s rounding and waits on their own (no database), then a full bucket's burst
  //    and a refusal with the wait, the refill and its cap, a bucket per user, twelve requests at once against
  //    three tokens, a clock going backwards, a refusal not losing refill, and Leo's chat bucket over a minute.
  throw new Error(
    `takeToken(${typeof tx}, ${viewer.userId}, ${bucket.name}, ${now.toISOString()}, cost ${cost}) isn't written yet`,
  );
}
