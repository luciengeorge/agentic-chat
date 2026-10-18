/** The token bucket lives in `#learn/boundary/rate-limit` (section 11.4); every importer keeps importing it from here. */
export { CHAT_BUCKET, takeToken, type Bucket, type RateLimitResult } from "#learn/boundary/rate-limit";
