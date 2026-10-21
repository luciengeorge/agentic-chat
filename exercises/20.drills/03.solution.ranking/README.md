---
title: The answers are a bit off
type: lab
---

# The answers are a bit off: the solution

**The cause, in two parts.** The trigger: `COHERE_RERANK_MODEL` in `src/lib/retrieval.server.ts` was renamed to `'rerank-4.0-fast'`, a model Cohere doesn't have, so every rerank call fails with a 404. The fault: `createRetrieve` in `src/core/retrieve/retrieve.ts` now wraps `rerankCandidates` in a `try`/`catch` that falls back to the fused order with a score of 0, and logs nothing. Retrieval fails open: it still answers, so nobody notices, and the reranker never runs. Without it, the first 8 chunks are whatever fusion (RRF, section 07) put first, which for the London question includes version 1 of the policy above version 2.

## The path a good debugger takes

1. **Read the whole report.** "A bit off" is vague, but three facts aren't: chat got faster, the logs are quiet, and the Cohere bill fell to almost nothing. Faster and cheaper together say a stage stopped doing work. The reranker is the only thing the app asks Cohere for, which puts it first in line.
2. **`/labs/rerank` confirms it.** Every row's place after reranking equals its place before, and every score is exactly 0. No real reranker gives 0 to 30 chunks: a cross-encoder's scores spread out (section 21's run from 0.00004 to 0.976). Something other than the reranker built these results.
3. **Is the reranker reachable?** Call `rerankerFromEnv().rerank("hotel", ["London: £200 a night"], 1)` from a scratch script: Cohere answers 404, model not found. That's one cause, and it explains the bill.
4. **Why didn't it fail?** A 404 from Cohere should have made retrieval, and the chat, fail. It didn't, so the error was caught somewhere between the reranker and the chat. Search `retrieve.ts` for what happens when `rerankCandidates` throws: a `catch` that returns the fused order with score 0. That's the second cause, and the one that hid the first.

## The fix

Both halves. Put the model id back to `'rerank-v4.0-fast'`. And remove the `try`/`catch` around `rerankCandidates`, so a reranker failure is a retrieval failure again: the chat says it couldn't answer, the error is logged, and someone gets paged. Restart `pnpm dev`. The check calls the app's reranker for real, then runs the fault's test: a throwing reranker must make `retrieve` reject. A deliberate fallback that degrades loudly (logs at error level, counts the fallback in a metric, marks the answer "unranked") is a design choice you could make on purpose, but it would fail this test, which wants the error to surface.

## The lesson

- **Failing open hides outages.** A fallback that's silent turns "the reranker is down" into "the answers are a bit off", which nobody can act on. Every fallback needs a signal: a log line at error level, a metric, an alert on its rate.
- **Cost and latency are telemetry.** A bill that drops and a request that speeds up, with no change meant to cause it, mean a stage stopped running. Section 19's metrics would have shown the rerank calls stop the day of the release.
- **Exact zeros are a fingerprint.** Real scores are messy. A column of identical values, 0 or 1.0 (section 21's pipeline trap), means the number came from code, not from a model.
