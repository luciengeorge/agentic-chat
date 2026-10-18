/**
 * What a failed workflow step should do next (section 05.2). Workflow retries a step that throws, up to the step's
 * `maxRetries` (3 unless the step says). A `RetryableError` says when to try again; a `FatalError` says not to try at
 * all; any other error is tried again straight away.
 */
import { FatalError, RetryableError } from "workflow";

import { ConnectorError } from "#learn/connectors/types";

/** The wait before retrying when the service didn't say how long (no `Retry-After`). */
export const DEFAULT_RETRY_AFTER_MS = 2_000;

/**
 * Throttling, outages and lost connections retry (after `Retry-After` when the service gave one); any other
 * answer from the service means the request itself is wrong, which retrying won't fix. Everything else passes
 * through as it is.
 */
export function stepError(error: unknown): unknown {
  if (error instanceof ConnectorError) {
    if (error.retryable) {
      return new RetryableError(error.message, { retryAfter: error.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS });
    }
    return new FatalError(error.message);
  }
  return error;
}
