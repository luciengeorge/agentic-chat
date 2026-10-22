// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { backoffMs, pollLoop } from "./poll-loop";

describe("backoffMs", () => {
  it("doubles the interval per failure, capped", () => {
    expect([0, 1, 2, 3, 4, 5].map((n) => backoffMs(n, 2_000, 30_000))).toEqual([
      2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
    expect(backoffMs(3, 30_000, 30_000)).toBe(30_000);
  });
});

describe("pollLoop", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const logger = () => ({ info: vi.fn(), error: vi.fn() });

  it("passes every interval while they work", async () => {
    const pass = vi.fn(async () => {});
    const loop = pollLoop({ name: "relay", intervalMs: 2_000, pass, logger: logger() });
    await vi.advanceTimersByTimeAsync(0);
    expect(pass).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(pass).toHaveBeenCalledTimes(4);
    loop.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pass).toHaveBeenCalledTimes(4);
  });

  it("backs off while passes fail, logs once going down and once on recovery", async () => {
    let down = true;
    const at: number[] = [];
    const pass = vi.fn(async () => {
      at.push(Date.now());
      if (down) throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
    });
    const log = logger();
    const start = Date.now();
    const loop = pollLoop({ name: "relay", intervalMs: 2_000, maxMs: 30_000, pass, logger: log });

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    // Waits of 4, 8, 16, then 30 s each: 0, 4, 12, 28, 58, 88, 118 s.
    expect(at.map((t) => (t - start) / 1_000)).toEqual([0, 4, 12, 28, 58, 88, 118]);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]?.[0]).toMatch(/relay failed/);
    expect(log.info).not.toHaveBeenCalled();

    down = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith("relay recovered", expect.objectContaining({ failures: 7 }));
    // Back to the interval, and quiet.
    const calls = pass.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(pass.mock.calls.length).toBe(calls + 2);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledTimes(1);
    loop.stop();
  });

  it("logs again when it goes down a second time", async () => {
    let down = true;
    const log = logger();
    const loop = pollLoop({
      name: "scheduler",
      intervalMs: 1_000,
      pass: async () => {
        if (down) throw new Error("down");
      },
      logger: log,
    });
    await vi.advanceTimersByTimeAsync(0);
    down = false;
    await vi.advanceTimersByTimeAsync(2_000);
    down = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(log.error).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledTimes(1);
    loop.stop();
  });

  it("a kick passes at once, and a kick during a pass runs one more right after", async () => {
    let release = () => {};
    const pass = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const loop = pollLoop({ name: "relay", intervalMs: 60_000, firstMs: 60_000, pass, logger: logger() });

    loop.kick();
    expect(pass).toHaveBeenCalledTimes(1);
    loop.kick();
    loop.kick();
    expect(pass).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(pass).toHaveBeenCalledTimes(2);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(pass).toHaveBeenCalledTimes(2);
    loop.stop();
  });
});
