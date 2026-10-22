// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { kickRelay, onRelayKick } from "@/db/outbox";
import { pollLoop } from "@/lib/poll-loop";

import { passAfterResponse, relayMode } from "./relay-kick";

const REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

describe("relayMode", () => {
  it("is the dev loop in dev, a pass after the response on Vercel, and nothing elsewhere", () => {
    expect(relayMode({ AC_ENV: "dev" })).toBe("loop");
    // `vercel env pull` writes VERCEL=1 into .env.local: dev keeps its loop.
    expect(relayMode({ AC_ENV: "dev", VERCEL: "1" })).toBe("loop");
    expect(relayMode({ AC_ENV: "prod", VERCEL: "1" })).toBe("after-response");
    expect(relayMode({ AC_ENV: "prod" })).toBe("off");
    expect(relayMode({ AC_ENV: "test" })).toBe("off");
  });
});

describe("passAfterResponse", () => {
  it("runs one pass per kick, handed to waitUntil", async () => {
    const pass = vi.fn(async () => ({ published: 1 }));
    const waited: Promise<unknown>[] = [];
    const off = onRelayKick(passAfterResponse(pass, (promise) => waited.push(promise)));
    try {
      kickRelay();
      expect(pass).toHaveBeenCalledTimes(1);
      expect(waited).toHaveLength(1);
      await waited[0];
      kickRelay();
      expect(pass).toHaveBeenCalledTimes(2);
    } finally {
      off();
    }
    kickRelay();
    expect(pass).toHaveBeenCalledTimes(2);
  });

  it("logs a failed pass instead of rejecting what waitUntil holds", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const waited: Promise<unknown>[] = [];
    passAfterResponse(
      () => Promise.reject(new Error("connect ECONNREFUSED")),
      (promise) => waited.push(promise),
    )();
    await expect(waited[0]).resolves.toBeUndefined();
    expect(String(error.mock.calls[0]?.[0])).toContain("relay kick pass failed");
    error.mockRestore();
  });

  it("hands the pass to the Vercel request's context, and runs it anyway outside one", async () => {
    const pass = vi.fn(async () => ({}));
    passAfterResponse(pass)();
    expect(pass).toHaveBeenCalledTimes(1);

    // What Vercel's runtime sets for each request, and @vercel/functions' waitUntil reads.
    const waitUntil = vi.fn();
    const store = globalThis as Record<symbol, unknown>;
    store[REQUEST_CONTEXT] = { get: () => ({ waitUntil }) };
    try {
      passAfterResponse(pass)();
    } finally {
      delete store[REQUEST_CONTEXT];
    }
    expect(pass).toHaveBeenCalledTimes(2);
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });
});

describe("in dev", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a kick wakes the relay's loop at once, as the plugin wires it", async () => {
    const pass = vi.fn(async () => {});
    const loop = pollLoop({ name: "relay", intervalMs: 2_000, firstMs: 2_000, pass, logger: console });
    const off = onRelayKick(loop.kick);
    try {
      kickRelay();
      expect(pass).toHaveBeenCalledTimes(1);
    } finally {
      off();
      loop.stop();
    }
  });
});
