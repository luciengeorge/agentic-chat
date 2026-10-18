---
title: Retries
type: graded
slots:
  queue/retry: retry.ts
---

# Retries

👨‍💼 A full sync of Kestrel's drive downloads 40 files in a burst, and SharePoint pushes back: "429 Too Many Requests, Retry-After: 1". Later the same day, someone deletes a file between the sync that saw it and the ingest that downloads it: "404 itemNotFound". The first should wait a second and try again. The second will never work, and retrying it only keeps the document stuck in "ingesting".

## Terms

- A **step**'s `maxRetries` is how many times Workflow tries it again after a throw: 3 by default, 5 for the download.
- A **`RetryableError`** asks for another try after a wait (`retryAfter`, in milliseconds). A **`FatalError`** asks for none: the step fails, and the run sees the error at once. Any other error is tried again straight away.
- **`Retry-After`** is a header a busy service sends with a 429 or a 503: the seconds to wait before asking again. The Graph client turns it into `retryAfterMs`.
- A **`ConnectorError`** is the drive's answer as an error: its `status` (0 when nothing answered), and `retryable` when that's 0, 429 or 5xx. By the time one reaches a step, the Graph client has already resent a 429 or a 503 a few times (section 02.3); a step retry is the next level up: the whole step again, after the wait the error names.
- **`asStep`** (in `src/workflows/sync-common.ts`) wraps a step's work: it runs it, and if it throws, it throws `stepError(error)` instead. So whatever your function returns is what Workflow sees.

## Do this

🐨 Write `stepError` in `playground/retry.ts`. Every ingest and sync step that talks to the drive runs inside `asStep`, which passes what it throws through your function before Workflow sees it.

## A worked example

Three ingest runs from the tests, on the real corpus:

| File                | What fake-workspace does    | Your answer            | Download step     |
| ------------------- | --------------------------- | ---------------------- | ----------------- |
| Code of Conduct.pdf | four 429s, `Retry-After: 1` | retry after 1,000 ms   | attempt 2, ready  |
| Office Guide.pdf    | deleted: 404 `itemNotFound` | fatal                  | attempt 1, failed |
| Pricing FAQ.pdf     | bytes that aren't a PDF     | pass the FatalError on | attempt 1, failed |

The Graph client absorbs the first three 429s itself (its own retries, honouring `Retry-After`), so only the fourth reaches the step.

Run the tests with `pnpm ex test 05.2`. They need Postgres (`pnpm ex up`); the ingest runs take about half a minute.
