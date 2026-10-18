// 👨‍💼 Ingestion talks to Kestrel's SharePoint (fake-workspace here), which sometimes says "too many requests, try
//    again in a second", sometimes falls over, and sometimes says "that file doesn't exist". Ingestion runs as
//    Workflow steps, and Workflow retries a step that throws. This file decides which failures deserve a retry,
//    and when.

/**
 * What a failed workflow step should do next (section 05.2). Workflow retries a step that throws, up to the step's
 * `maxRetries` (3 unless the step says). A `RetryableError` says when to try again; a `FatalError` says not to try at
 * all; any other error is tried again straight away.
 */
import { FatalError } from "workflow";

/** The wait before retrying when the service didn't say how long (no `Retry-After`). */
export const DEFAULT_RETRY_AFTER_MS = 2_000;

/**
 * Throttling, outages and lost connections retry (after `Retry-After` when the service gave one); any other
 * answer from the service means the request itself is wrong, which retrying won't fix. Everything else passes
 * through as it is.
 */
export function stepError(error: unknown): unknown {
  // 🐨 A ConnectorError is the drive's answer. When it's `retryable` (no answer at all, 429 or 5xx), return a
  //    RetryableError with the same message, retrying after the wait the service asked for (`retryAfterMs`), or
  //    after DEFAULT_RETRY_AFTER_MS when it didn't say.
  // 🐨 Any other ConnectorError (a 404, a 403, a 400) is the request's own fault: return a FatalError with the same
  //    message.
  // 🐨 Return anything else unchanged: a FatalError or RetryableError thrown on purpose keeps its meaning, and a
  //    plain Error (a bug, a database blip) keeps Workflow's default retries.
  //
  // 💰 `new RetryableError(message, { retryAfter: ms })` and `new FatalError(message)`: import RetryableError from
  //    "workflow" next to FatalError, and ConnectorError from "#learn/connectors/types". `retryAfter` takes
  //    milliseconds (or a string such as "5s"); `retryAfterMs` is already in milliseconds.
  //
  // 🦉 Why not retry everything. A step retries up to its `maxRetries` (5 for the download). A file that's gone
  //    answers 404 every time: five more tries change nothing, and the document sits in "ingesting" meanwhile. A FatalError fails the step on its first attempt, so the run marks the document
  //    failed at once.
  // 🦉 Why not fail everything. A 429 means "slow down", not "never". The Graph client already absorbs three in a
  //    row; the fourth reaches the step, and failing the ingest for it would drop a good document for being busy.
  // 🦉 Why honour Retry-After. The service knows when it can take the next request. Retry sooner and you're
  //    throttled again (and push everyone else's limit down); retry later and the ingest waits for nothing. The
  //    classic mistake is the units: the header says seconds, `retryAfterMs` is milliseconds, and so is
  //    `retryAfter`. Divide by 1,000 and a 30-second wait becomes 30 milliseconds.
  // 🦉 Why pass the rest through. `storeBlob` throws its own FatalError for bytes that aren't a PDF. Wrap it as
  //    retryable and a broken file is downloaded five more times.
  //
  // 📜 https://workflow-sdk.dev/docs/foundations/errors-and-retries
  // 📜 https://www.rfc-editor.org/rfc/rfc9110#field.retry-after
  //
  // 🚨 The tests check that a 429 retries after its Retry-After and a 503 after 2 seconds, that no answer at all
  //    retries, that a 404 or a 403 is fatal, that FatalError, RetryableError and plain errors pass through
  //    unchanged, and, in real ingest runs, that a download throttled four times succeeds on its second attempt
  //    while a deleted file and a broken PDF fail on their first.
  throw new FatalError(`stepError(${error instanceof Error ? error.name : typeof error}) isn't written yet`);
}
