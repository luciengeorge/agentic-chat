---
title: A token bucket in Postgres
type: graded
slots:
  boundary/rate-limit: rate-limit.ts
---

# A token bucket in Postgres

👨‍💼 Each question Leo asks costs Kestrel a query rewrite, embeddings, a Cohere rerank and a gpt-6-luna answer. A stuck retry loop in his browser, or a script with his cookie, could ask hundreds a minute and run the bill up for everyone. The chat allows a burst of 10, then one question every 6 seconds, per person, however many servers the app runs on.

## Terms

- A **rate limit** caps how often someone may do something. **429** (Too Many Requests) is the HTTP answer, with a **Retry-After** header saying how many seconds to wait.
- A **token bucket** holds up to a **capacity** of tokens and **refills** at a steady rate. Each request takes one; with none left, it's refused.
- `CHAT_BUCKET` is 10 tokens and 10 a minute: one every 6 seconds.
- A **row lock** is Postgres making a second UPDATE of the same row wait until the first one's transaction ends. A **race** is two requests reading the same old value and both acting on it.

## Do this

🐨 In `playground/rate-limit.ts`, write `bucketResult` first: the arithmetic that turns the bucket's tokens into `remaining` and `Retry-After`. Its tests run without the database, so you see it work before any SQL.

🐨 Then write `takeToken`: two statements, inside the caller's tenant transaction. Make the bucket row if it's missing, then one UPDATE that refills it, takes a token if there is one, and says which. `handleChat` calls it before any retrieval and answers 429 when you refuse.

## A worked example

Leo, from 09:00:00, with the chat bucket:

| When     | Asks | Tokens before | Answer                   |
| -------- | ---- | ------------- | ------------------------ |
| 09:00:00 | 10   | 10            | all allowed, 9 to 0 left |
| 09:00:00 | 1    | 0             | 429, Retry-After 6       |
| 09:00:03 | 1    | 0.5           | 429, Retry-After 3       |
| 09:00:06 | 1    | 1             | allowed, 0 left          |
| 09:01:06 | 1    | 10 (capped)   | allowed, 9 left          |

At 09:01:06 sixty seconds have refilled 10 tokens; the cap keeps him at 10, so a quiet hour can't become a burst of 600. And twelve requests at the same instant against 3 tokens let exactly 3 through.

Run the tests with `pnpm ex test 11.4`. They need Postgres (`pnpm ex up`).
