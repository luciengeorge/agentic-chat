import { createHmac, timingSafeEqual } from "node:crypto";

/** The header ingest steps send to the app's page routes, which nothing else may call. */
export const INTERNAL_HEADER = "x-ac-internal";

/** Derived from BETTER_AUTH_SECRET, so it needs no secret of its own and changes when that one does. */
export function internalToken(secret = process.env.BETTER_AUTH_SECRET): string {
  if (!secret) throw new Error("BETTER_AUTH_SECRET must be set");
  return createHmac("sha256", secret).update("agentic-chat:ingest-pages").digest("hex");
}

export function isInternal(request: Request): boolean {
  const sent = Buffer.from(request.headers.get(INTERNAL_HEADER) ?? "");
  const want = Buffer.from(internalToken());
  return sent.length === want.length && timingSafeEqual(sent, want);
}
