---
title: 429 and Retry-After
type: graded
slots:
  connectors/graph: graph.ts
---

# 429 and Retry-After

👨‍💼 Kestrel's first big sync goes wrong at 2 a.m.: SharePoint starts answering 429, "too many requests", halfway through the crawl. The client gives up at the first refusal, so the sync fails and starts again from the top, and throttles again. SharePoint said how long to wait. The client should have waited.

## Terms

- **429 Too Many Requests** means the source is refusing you for now because you've sent too much. **503 Service Unavailable** means it's busy or down for a moment.
- **`Retry-After`** is a header on those answers: a number of seconds, or a date, after which to try again.
- **Exponential backoff** is waiting longer after each failure, here doubling: 500 ms, 1 s, 2 s, 4 s... A **cap** is the most it will ever wait.
- **Retryable** marks an error worth trying again later (`ConnectorError.retryable`): a 429, any 5xx, or no answer at all. It's a broad label, read by the sync step in section 05.2, which runs the whole step again a little later, a few times at most. The client itself is stricter: it waits and resends a request only on a 429 or a 503, the two answers that mean "come back in a moment".

## Do this

🐨 Write `retryDelay` in `playground/graph.ts`: given a refused answer and how many times you've tried, say how many milliseconds to wait, or `null` to give up. `send` already loops on it; the hints say what's new.

## A worked example

fake-workspace can throttle on demand. Tell it to let 6 requests through and then answer 429 twice, with `Retry-After: 3`. A crawl at `$top=5` normally takes 20 requests. Now requests 7 and 8 are refused; each time your client waits 3,000 ms and sends the same request again, and the third try works. 22 requests, two 3-second waits, all 40 files.

With no `Retry-After` (a 503 three times), the client waits 500, then 1,000, then 2,000 ms. Throttled for good, with `maxRetries` at 2, it tries 3 times, waits 7,000 ms twice (`Retry-After: 7`), and gives up with a retryable error that still says 7,000. A token for the wrong site gets a 403: one request, no wait. A 500 (the server broke on this request) is one request too, with no wait, but its error is still marked retryable, for the sync step.

Run the tests with `pnpm ex test 02.3`.
