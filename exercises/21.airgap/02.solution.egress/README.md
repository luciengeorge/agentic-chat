---
title: Egress blocked
type: graded
slots:
  local/egress: egress.ts
---

# Egress blocked: the solution

`isLoopback` strips any brackets and lower-cases the host. `localhost` and `*.localhost` are this machine; otherwise the host must be an address (`isIP`), an IPv4 one starting `127.` or the IPv6 `::1` (or `::ffff:127.x`, an IPv4 loopback written as IPv6). `guardEgress` keeps the original `Socket.prototype.connect` and puts a `function` in its place. It reads the call's target with `connectTarget`. A Unix socket, a loopback host or one `allow` accepts goes on to the original, with the same `this` and arguments, and is listed in `allowed`. Anything else is pushed onto `blocked` with the time, and the socket is destroyed with an `EgressBlockedError` on the next tick; the patched `connect` returns the socket as the real one would. `restore` puts the original back.

## Why it works

- **One method sees every client.** `net.connect()` and `tls.connect()` only build a socket and call its `connect()`. fetch (so the AI SDK) uses `tls.connect` for https; postgres.js makes a `Socket` and calls `connect()` itself. Patch `net.connect` and both walk past. Patch the prototype and nothing does, short of a child process or native code, which is why the network is the wall and this is the check.
- **It decides before anything happens.** The original `connect()` starts the DNS lookup, and a DNS question is already egress: it says which host the app wanted, to whoever runs the resolver. So the decision comes first, and a refused socket never calls the original.
- **It fails the way a network does.** Callers attach their error handlers after `connect()` returns. Destroying the socket on the next tick fails it with an `error` event, exactly where a refused connection would land, so fetch rejects with `EgressBlockedError` as its `cause` and postgres reports it. A throw would come out of `connect()` itself, into code that wasn't expecting one.
- **Text isn't an address.** `127.example.com` starts with 127 and `localhost.evil.com` contains localhost; both resolve wherever their owners like. Only an address or the reserved name `localhost` is known to stay on the machine without asking DNS.

## The worked example

Each refused attempt takes milliseconds, so the time to fail is the caller's retry policy. With the AI SDK's defaults, OpenAI's embeddings tried 3 times, 2 s and 4 s apart (6,378 ms measured, 6,000 of it sleeping). The app's reranker retries 5 times to wait out a trial key's rate limit, so Cohere's rerank tried 6 times over 62,030 ms. The test reads those gaps from your `blocked` list on a fake clock: [2000, 4000] and [2000, 4000, 8000, 16000, 32000]. The lesson for any air-gapped deploy: a client that can't reach its host is worse than no client, because it doesn't fail fast. `MODEL_PROVIDER=local` builds no OpenAI or Cohere client at all, even with their keys set.

## Where it runs

- `scripts/local-guard.ts` loads it before a script (`tsx --import`), so `pnpm local:eval` runs the golden set under it and prints what it refused at exit: 0 refused, only `localhost:5432` and `127.0.0.1:1234` allowed.
- `pnpm local:egress-check` runs the network probe, then a golden question through local retrieval under the monitor, then the hosted clients above.
- `/labs/airgap` switches it on inside the dev server, with your code while this step is active.
