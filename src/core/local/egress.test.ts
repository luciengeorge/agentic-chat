// @vitest-environment node
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { EgressBlockedError, type EgressGuard, guardEgress, isLoopback } from "./egress";

describe("isLoopback", () => {
  it("knows this machine's names and addresses", () => {
    for (const host of ["localhost", "LOCALHOST", "app.localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]"]) {
      expect(isLoopback(host), host).toBe(true);
    }
    for (const host of ["api.openai.com", "api.cohere.com", "10.0.0.1", "192.168.1.2", "::2", "localhost.evil.com"]) {
      expect(isLoopback(host), host).toBe(false);
    }
  });
});

describe("guardEgress", () => {
  let guard: EgressGuard | undefined;
  let server: Server | undefined;
  afterEach(() => {
    guard?.restore();
    server?.close();
  });

  it("refuses a connection off the machine at once, before any DNS lookup, and records it", async () => {
    guard = guardEgress();
    const started = performance.now();
    const error = await fetch("https://api.openai.com/v1/models").catch((e: Error) => e);
    expect(performance.now() - started).toBeLessThan(500);
    expect((error as Error).cause).toBeInstanceOf(EgressBlockedError);
    expect(guard.blocked).toEqual([{ host: "api.openai.com", port: 443, at: expect.any(Date) }]);
  });

  it("lets loopback through", async () => {
    server = createServer((_, response) => response.end("ok"));
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
    const { port } = server.address() as { port: number };
    guard = guardEgress();
    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(await response.text()).toBe("ok");
    expect(guard.blocked).toEqual([]);
    expect(guard.allowed).toContain(`127.0.0.1:${port}`);
  });

  it("lets through the hosts it's told to, and comes off with restore()", async () => {
    server = createServer((_, response) => response.end("ok"));
    await new Promise<void>((done) => server!.listen(0, "0.0.0.0", done));
    const { port } = server.address() as { port: number };
    guard = guardEgress();
    await expect(fetch(`http://0.0.0.0:${port}/`)).rejects.toThrow();
    guard.restore();
    guard = guardEgress({ allow: (host) => host === "0.0.0.0" });
    expect(await (await fetch(`http://0.0.0.0:${port}/`)).text()).toBe("ok");
    guard.restore();
    guard = undefined;
    expect(await (await fetch(`http://0.0.0.0:${port}/`)).text()).toBe("ok");
  });
});
