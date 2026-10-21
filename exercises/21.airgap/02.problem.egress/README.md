---
title: Egress blocked
type: graded
slots:
  local/egress: egress.ts
---

# Egress blocked

👨‍💼 Step 1 moved every model onto the machine. Kestrel's regulator will still ask: how do you know nothing left? "We set `MODEL_PROVIDER=local`" is a setting, not proof. One forgotten client, a library that phones home, a key left in `.env.local`, and a tenant's question goes to the internet. So there are two layers: a network with no way out, and a monitor in the app that refuses, and lists, every connection that would leave.

## Terms

- **Egress** is traffic leaving the network. **Air-gapped** means there's no route for it at all.
- **Loopback** is this machine talking to itself: `127.0.0.0/8` and `::1`, and the name `localhost`. Those packets never reach a network card.
- A **socket** is one end of a network connection. In Node, every TCP connection is a `net.Socket`, and `connect()` is what starts it: it looks the name up in DNS (the internet's address book), then dials the address.
- **Patching** a method means replacing it at run time, so every caller gets your version. Here it's `net.Socket.prototype.connect`, the one method every socket shares.

## The wall, already built

The `airgap` Compose profile has a network with `internal: true`: no gateway, so nothing on it can reach the internet, the host or its LAN. `pnpm local:egress-check` runs a probe inside it. DNS for api.openai.com, api.cohere.com and huggingface.co didn't resolve; TCP to 1.1.1.1 and 8.8.8.8 got "network is unreachable"; even LM Studio on the host (host.docker.internal:1234) was out of reach. Every attempt failed in 4 to 15 ms, and the database on the same network answered in 6 ms.

## Do this

🐨 In `playground/egress.ts`, write `isLoopback`, then `guardEgress`: replace `Socket.prototype.connect` so a connection to this machine goes through, and any other fails before it starts, with `EgressBlockedError`, and is written down. `connectTarget`, which reads where a `connect()` call is going from its four call shapes, is written.

## A worked example

Refusing is fast. What the caller does next may not be. With the monitor on, `pnpm local:egress-check` called the hosted clients as a misconfigured app would:

| Call                                            | Attempts | Time to fail |
| ----------------------------------------------- | -------: | -----------: |
| OpenAI embeddings, no retries                   |        1 |        18 ms |
| Cohere rerank, no retries                       |        1 |         5 ms |
| OpenAI embeddings, the AI SDK's default retries |        3 |     6,378 ms |
| Cohere rerank, the app's retries                |        6 |    62,030 ms |

Each refusal took milliseconds. The rest is the retry policy sleeping: 2 s and 4 s for OpenAI (6 s), and 2, 4, 8, 16 and 32 s for Cohere (62 s). A chat that reached a hosted client in local mode wouldn't fail fast: it would wait a minute, then fail. That's why local mode never builds one.

Run the tests with `pnpm ex test 21.2`. They never reach the network: every connection they open is refused, sent to this machine, or given a DNS lookup that answers nothing. The last one runs the AI SDK on a fake clock and reads your `blocked` list's times.

The lab, `/labs/airgap`, turns your monitor on inside the dev server and shows what it lets through and what it refuses.
