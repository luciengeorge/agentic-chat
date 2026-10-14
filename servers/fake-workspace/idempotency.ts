/**
 * `Idempotency-Key` for the write routes. The first request with a key does the work and its answer is kept; the
 * same key with the same request gets that answer again and does nothing; the same key with a different request
 * is refused with a 422. Keys are per site. Only successful answers are kept: a refused request changed nothing,
 * so trying it again is safe.
 */
import type { Context } from "hono";

import { GraphError } from "./errors";
import { sha256 } from "./site";

export const IDEMPOTENCY_HEADER = "idempotency-key";

interface Kept {
  readonly fingerprint: string;
  readonly status: number;
  readonly body: unknown;
}

export class IdempotencyKeys {
  private readonly kept = new Map<string, Kept>();

  clear(): void {
    this.kept.clear();
  }

  /**
   * Runs `work` once per key. Call it after every `await` of the request (the body read, the faults), so that two
   * requests with one key can't both get past the lookup.
   */
  run(c: Context, site: string, request: unknown, work: () => { status: number; body: unknown }): Response {
    const key = c.req.header(IDEMPOTENCY_HEADER);
    if (key === undefined) return respond(work());
    if (!key || key.length > 255) throw new GraphError(400, "invalidRequest", "Idempotency-Key: 1 to 255 characters.");
    const id = `${site}\n${key}`;
    const fingerprint = sha256(`${c.req.method} ${new URL(c.req.url).pathname}\n${JSON.stringify(request)}`);
    const kept = this.kept.get(id);
    if (kept) {
      if (kept.fingerprint !== fingerprint) {
        throw new GraphError(422, "idempotencyKeyReused", "This Idempotency-Key was used for a different request.");
      }
      return respond(kept, true);
    }
    const answer = work();
    if (answer.status < 300) this.kept.set(id, { fingerprint, ...answer });
    return respond(answer);
  }
}

function respond({ status, body }: { status: number; body: unknown }, replayed = false): Response {
  const headers = replayed ? { "Idempotent-Replayed": "true" } : undefined;
  return body === null ? new Response(null, { status, headers }) : Response.json(body, { status, headers });
}
