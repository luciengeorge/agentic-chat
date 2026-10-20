---
title: Air-gapped, done
---

# Air-gapped, done

The assistant can now run with nothing leaving the machine. Your reranker scores each chunk with a sigmoid over the cross-encoder's one logit, so it tells the London policy's version 2 from the Brightwell contacts (0.959 against 0.00004), where the pipeline API said 1.0 for both. Your monitor refuses every connection off the machine before its DNS lookup and lists it, from fetch, tls and postgres alike. And your vendoring fetches weights so that a short, corrupted or cut-off file never sits where the reranker loads, and saves the paradedb image once: 3.83 GB for the whole bundle, before a chat model.

## What to notice in the lab

Open `/labs/airgap`, signed in as anyone, in dev.

- **The models.** With `MODEL_PROVIDER` unset, all three leave the machine: OpenAI for chat and embeddings, Cohere for reranking (or fakes, with no keys). With `MODEL_PROVIDER=local` they're LM Studio at `127.0.0.1:1234` and this process.
- **Turn the monitor on, then press "OpenAI".** It's refused in a millisecond or two, "before any DNS lookup", and appears under Refused. Press "ParadeDB": connected, and `localhost:5432` is counted under Let through, with each new connection the app opens from then on.
- **With hosted models, ask the chat something while it's on.** The chat fails, after the AI SDK's retries: about 6 s for the OpenAI embedding, and the refusals pile up under Refused. That's the worked example of step 2, live. Turn it off before you go on.
- **The last egress check.** From inside the `airgap` network, every way out failed in 4 to 15 ms, and only the database on the same network answered.

## What's still open

- The answer eval on local models waits for a chat model. Qwen3 8B (about 5 GB): `lms get qwen/qwen3-8b`, `lms load qwen/qwen3-8b -c 16384`, then `pnpm local:eval` and `pnpm local:bench` for time to first token and tokens per second.
- The chat and the labs on local models need that chat model too, since the rewriter runs before every search.
- The local reranker in `pnpm dev` hasn't been run against the full app; the scripts, the tests and a local production build (`pnpm build:local`) have.

## What comes next

Section 22 ships the hosted app: Vercel for the app and its workflows, ParadeDB in the cloud, secrets, migrations and CI. It's the other end of this section: there, `pnpm build` leaves the 330 MB of local models out, and every model call leaves the machine on purpose.
