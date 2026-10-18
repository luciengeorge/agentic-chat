---
title: Retries
type: graded
slots:
  queue/retry: retry.ts
---

# Retries: the solution

`stepError` looks at what a step threw. A `ConnectorError` that's `retryable` becomes a `RetryableError` with the same message and `retryAfter` set to the service's `retryAfterMs`, or 2,000 ms when it gave none. Any other `ConnectorError` becomes a `FatalError`. Anything else goes back unchanged.

## Why it works

- **It retries what time can fix.** A 429 means "too fast", a 5xx means "broken right now", and status 0 means nothing answered. All three can work on the next try.
- **It stops what time can't.** A 404, a 403 or a 400 is an answer about the request itself, and the same request gets the same answer. A `FatalError` fails the step on its first attempt, so the run marks the document failed at once instead of after five more downloads.
- **It waits as long as it was asked to.** `Retry-After` is the service saying when it can take more. Both `retryAfterMs` and `retryAfter` are milliseconds, so the value passes straight through. Divide by 1,000 and a 30-second wait becomes 30 milliseconds: the retry is throttled again.
- **It leaves other errors alone.** `storeBlob` throws its own `FatalError` for bytes that aren't a PDF; that has to stay fatal. A plain error, a bug or a database blip, keeps Workflow's default of retrying straight away.

## The worked example

The Code of Conduct's download meets four 429s with `Retry-After: 1`. The Graph client retries the first three itself; the fourth reaches the step as a `ConnectorError` with `retryAfterMs` 1,000, and your `RetryableError` makes Workflow wait a second. Attempt 2 downloads it, and the document is ready. Office Guide.pdf, deleted from the drive, answers 404: fatal, one attempt, document failed. Pricing FAQ.pdf, replaced with bytes that aren't a PDF, fails `pdfPageCount`; `storeBlob` throws a `FatalError` and you pass it on: one attempt.

Retries cost wall-clock time, even in tests: the local world enforces `retryAfter` itself (`docs/workflow-notes.md`, section c). That's why the throttle in the test asks for 1 second and not 30.
