// @vitest-environment node
import { describe, expect, it } from "vitest";
import { FatalError, RetryableError } from "workflow";

import { ConnectorError } from "#learn/connectors/types";
import { DEFAULT_RETRY_AFTER_MS, stepError } from "#learn/queue/retry";

const graph = (status: number, code: string, retryAfterMs: number | null = null) =>
  new ConnectorError(status, code, `GET /drive/items/x/content answered ${status} ${code}`, retryAfterMs);
/** Milliseconds from now until a RetryableError says to try again. */
const waitOf = (error: unknown) => (error as RetryableError).retryAfter.getTime() - Date.now();

describe("what a failed step does next", () => {
  it("retries a 429 after the wait its Retry-After asked for", () => {
    const error = stepError(graph(429, "TooManyRequests", 30_000));
    expect(RetryableError.is(error), "a 429 means slow down, not never: retry it").toBe(true);
    expect(waitOf(error), "Retry-After said 30 s: retryAfter takes milliseconds, as retryAfterMs is").toBeGreaterThan(
      29_000,
    );
    expect(waitOf(error)).toBeLessThanOrEqual(30_000);
    expect((error as Error).message).toBe("GET /drive/items/x/content answered 429 TooManyRequests");
  });

  it("retries an outage after 2 seconds when the service gave no Retry-After, and no answer at all too", () => {
    for (const error of [stepError(graph(503, "serviceNotAvailable")), stepError(graph(0, "network"))]) {
      expect(RetryableError.is(error), "5xx and no answer (status 0) are worth a retry").toBe(true);
      expect(waitOf(error)).toBeGreaterThan(DEFAULT_RETRY_AFTER_MS - 1_000);
      expect(waitOf(error)).toBeLessThanOrEqual(DEFAULT_RETRY_AFTER_MS);
    }
  });

  it("fails at once on an answer that says the request itself is wrong: 404, 403, 400", () => {
    for (const status of [404, 403, 400]) {
      const error = stepError(graph(status, "itemNotFound"));
      expect(FatalError.is(error), `a ${status} answers the same every time: make it a FatalError`).toBe(true);
      expect((error as Error).message).toContain(`answered ${status}`);
    }
  });

  it("passes other errors through unchanged, so they keep their own meaning", () => {
    const fatal = new FatalError("not a readable PDF: Invalid PDF structure");
    const retryable = new RetryableError("the page route answered 502", { retryAfter: 2_000 });
    const bug = new TypeError("Cannot read properties of undefined (reading 'bytes')");
    expect(stepError(fatal), "a FatalError thrown on purpose must stay fatal").toBe(fatal);
    expect(stepError(retryable)).toBe(retryable);
    expect(stepError(bug), "a plain error keeps Workflow's default retries: return it as it is").toBe(bug);
  });
});
