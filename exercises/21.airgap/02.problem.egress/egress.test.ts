// @vitest-environment node
import { createCohere } from "@ai-sdk/cohere";
import { createOpenAI } from "@ai-sdk/openai";
import { embedMany } from "ai";
import { createServer, type Server } from "node:http";
import net from "node:net";
import tls from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EgressBlockedError, type EgressGuard, guardEgress, isLoopback } from "#learn/local/egress";
import { aiSdkReranker } from "#learn/rerank/rerank";

const ORIGINAL_CONNECT = net.Socket.prototype.connect;

/** A DNS lookup that never asks anyone: if it's called, the guard let the connection start. */
function lookupSpy() {
  return vi.fn<net.LookupFunction>((hostname, _options, callback) => {
    callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }), "", 4);
  });
}

/** The error a socket fails with, or null if nothing failed it within `ms`. */
function failure(socket: net.Socket, ms = 500): Promise<Error | null> {
  return new Promise((done) => {
    const timer = setTimeout(() => {
      socket.destroy();
      done(null);
    }, ms);
    socket.once("error", (error) => {
      clearTimeout(timer);
      done(error);
    });
  });
}

let guard: EgressGuard | undefined;
let server: Server | undefined;
afterEach(() => {
  guard?.restore();
  guard = undefined;
  net.Socket.prototype.connect = ORIGINAL_CONNECT;
  server?.close();
  server = undefined;
  vi.useRealTimers();
});

async function listen(host: string) {
  server = createServer((_, response) => response.end("ok"));
  await new Promise<void>((done) => server!.listen(0, host, done));
  return (server.address() as { port: number }).port;
}

describe("isLoopback", () => {
  it("knows this machine's names and addresses", () => {
    for (const host of ["localhost", "LOCALHOST", "app.localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]"]) {
      expect(isLoopback(host), `${host} is this machine`).toBe(true);
    }
    expect(isLoopback("::ffff:127.0.0.1"), "an IPv4 loopback written as IPv6 is this machine too").toBe(true);
  });

  it("refuses everything else, look-alikes included", () => {
    for (const host of ["api.openai.com", "10.0.0.1", "192.168.1.2", "0.0.0.0", "::2", "huggingface.co"]) {
      expect(isLoopback(host), `${host} is off the machine`).toBe(false);
    }
    expect(isLoopback("127.example.com"), "a name that starts with 127 isn't an address: check isIP first").toBe(false);
    expect(isLoopback("localhost.evil.com"), "localhost.evil.com resolves wherever its owner likes").toBe(false);
  });
});

describe("guardEgress", () => {
  it("refuses a connection off the machine before any DNS lookup, and records it", async () => {
    guard = guardEgress();
    const lookup = lookupSpy();
    const socket = net.connect({ host: "api.openai.com", port: 443, lookup });
    const error = await failure(socket);
    expect(
      lookup,
      "decide before calling the original connect: it starts the DNS lookup, and that question already leaves the machine",
    ).not.toHaveBeenCalled();
    expect(error, "the socket fails with an EgressBlockedError").toBeInstanceOf(EgressBlockedError);
    expect(guard.blocked).toEqual([{ host: "api.openai.com", port: 443, at: expect.any(Date) }]);
  });

  it("fails the socket on the next tick, rather than throwing from connect()", async () => {
    guard = guardEgress();
    let socket: net.Socket | undefined;
    expect(
      () => (socket = net.connect({ host: "api.cohere.com", port: 443, lookup: lookupSpy() })),
      "a throw inside connect() escapes the client's handlers: destroy the socket with the error on the next tick",
    ).not.toThrow();
    expect(await failure(socket!)).toBeInstanceOf(EgressBlockedError);
    expect(socket!.destroyed).toBe(true);
  });

  it("catches every way a client opens a socket: net.connect, a bare Socket, tls.connect", async () => {
    guard = guardEgress();
    const lookup = lookupSpy();
    const bare = new net.Socket().connect({ host: "db.kestrel.example", port: 5432, lookup });
    expect(
      await failure(bare),
      "postgres.js makes a Socket and calls socket.connect(): patch Socket.prototype.connect, not net.connect",
    ).toBeInstanceOf(EgressBlockedError);
    const secure = tls.connect({ host: "huggingface.co", port: 443, lookup });
    expect(
      await failure(secure),
      "tls.connect (so fetch over https) makes a TLSSocket and calls its connect(): the prototype is shared",
    ).toBeInstanceOf(EgressBlockedError);
    // An address needs no lookup; 192.0.2.1 is reserved for examples, so nothing answers there.
    const positional = new net.Socket().connect(443, "192.0.2.1");
    expect(await failure(positional), "connect(port, host), the oldest call shape").toBeInstanceOf(EgressBlockedError);
    expect(lookup).not.toHaveBeenCalled();
    expect(guard.blocked.map((attempt) => `${attempt.host}:${attempt.port}`)).toEqual([
      "db.kestrel.example:5432",
      "huggingface.co:443",
      "192.0.2.1:443",
    ]);
  });

  it("lets this machine through, and lists where", async () => {
    const port = await listen("127.0.0.1");
    guard = guardEgress();
    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(await response.text(), "loopback goes through the original connect").toBe("ok");
    expect(guard.blocked).toEqual([]);
    expect(guard.allowed, "each connection let through, as host:port").toContain(`127.0.0.1:${port}`);
  });

  it("lets through the hosts allow names, on top of loopback, and comes off with restore()", async () => {
    const port = await listen("0.0.0.0");
    guard = guardEgress();
    await expect(fetch(`http://0.0.0.0:${port}/`), "0.0.0.0 isn't loopback").rejects.toThrow();
    guard.restore();
    expect(net.Socket.prototype.connect, "restore() puts the original connect back").toBe(ORIGINAL_CONNECT);

    guard = guardEgress({ allow: (host) => host === "0.0.0.0" });
    expect(await (await fetch(`http://0.0.0.0:${port}/`)).text()).toBe("ok");
    const local = await listen("127.0.0.1");
    const text = await fetch(`http://127.0.0.1:${local}/`).then(
      (response) => response.text(),
      () => "refused",
    );
    expect(text, "allow adds hosts to loopback; it doesn't replace it").toBe("ok");
  });

  it("turns one refusal into 6 s of retries for OpenAI's embeddings and 62 s for Cohere's rerank", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    guard = guardEgress();
    // First, that a TLS socket is refused: if it weren't, the calls below would really go out.
    expect(await failure(tls.connect({ host: "api.openai.com", port: 443, lookup: lookupSpy() }), 50)).toBeInstanceOf(
      EgressBlockedError,
    );
    guard.blocked.length = 0;

    const gaps = (attempts: { at: Date }[]) =>
      attempts.slice(1).map((attempt, i) => attempt.at.getTime() - attempts[i]!.at.getTime());
    const run = async (call: () => Promise<unknown>) => {
      const from = guard!.blocked.length;
      const settled = call().then(
        () => null,
        (error: unknown) => error,
      );
      await vi.runAllTimersAsync();
      expect(await settled, "a refused call fails, it never hangs").toBeInstanceOf(Error);
      return guard!.blocked.slice(from);
    };
    const openai = createOpenAI({ apiKey: "sk-airgap-test" });
    const cohere = createCohere({ apiKey: "airgap-test" });

    const once = await run(() =>
      embedMany({ model: openai.embedding("text-embedding-3-small"), values: ["x"], maxRetries: 0 }),
    );
    expect(
      once.map((attempt) => attempt.host),
      "with no retries: one attempt, refused at once",
    ).toEqual(["api.openai.com"]);

    const embeddings = await run(() => embedMany({ model: openai.embedding("text-embedding-3-small"), values: ["x"] }));
    expect(embeddings, "the AI SDK retries twice by default: three attempts").toHaveLength(3);
    expect(gaps(embeddings), "it waits 2 s, then 4 s, between them").toEqual([2000, 4000]);

    const rerank = await run(() =>
      aiSdkReranker(cohere.reranking("rerank-v4.0-fast"), "cohere").rerank("hotel", ["£200 a night"], 1),
    );
    expect(rerank.map((attempt) => attempt.host)).toEqual(Array(6).fill("api.cohere.com"));
    expect(gaps(rerank), "the app's reranker retries five times: 2 + 4 + 8 + 16 + 32 = 62 s").toEqual([
      2000, 4000, 8000, 16000, 32000,
    ]);
  });
});
