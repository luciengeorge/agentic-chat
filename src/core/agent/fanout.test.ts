import { describe, expect, it } from "vitest";

import { fanOut } from "./fanout";

/** A child that runs until the test lets it finish. */
function controllable() {
  const started: number[] = [];
  const finish = new Map<number, (value: string) => void>();
  let running = 0;
  let peak = 0;
  const run = (_: unknown, index: number) =>
    new Promise<string>((resolve) => {
      started.push(index);
      running += 1;
      peak = Math.max(peak, running);
      finish.set(index, (value) => {
        running -= 1;
        resolve(value);
      });
    });
  return { started, finish, run, peak: () => peak };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("fanOut", () => {
  it("never runs more than the limit at once; the rest queue and start in order as slots free up", async () => {
    const c = controllable();
    const done = fanOut([0, 1, 2, 3, 4, 5], { limit: 2, run: c.run });
    await tick();
    expect(c.started).toEqual([0, 1]);

    c.finish.get(1)!("b");
    await tick();
    expect(c.started).toEqual([0, 1, 2]);

    c.finish.get(0)!("a");
    c.finish.get(2)!("c");
    await tick();
    expect(c.started).toEqual([0, 1, 2, 3, 4]);

    c.finish.get(3)!("d");
    c.finish.get(4)!("e");
    await tick();
    c.finish.get(5)!("f");

    expect(await done).toEqual(["a", "b", "c", "d", "e", "f"].map((value) => ({ kind: "done", value })));
    expect(c.peak()).toBe(2);
  });

  it("asks before each child and skips the rest once told to stop (the kill switch, a spent budget)", async () => {
    const admitted: number[] = [];
    const results = await fanOut([0, 1, 2, 3], {
      limit: 2,
      admit: async (_, index) => {
        admitted.push(index);
        return index < 2 ? { go: true } : { go: false, reason: "kill switch: incident 42" };
      },
      run: async (item) => item * 10,
    });
    expect(results).toEqual([
      { kind: "done", value: 0 },
      { kind: "done", value: 10 },
      { kind: "skipped", reason: "kill switch: incident 42" },
      { kind: "skipped", reason: "kill switch: incident 42" },
    ]);
    expect(admitted.slice(0, 3)).toEqual([0, 1, 2]);
  });

  it("keeps going past a child that fails", async () => {
    const results = await fanOut(["a", "b"], {
      limit: 1,
      run: async (item) => {
        if (item === "a") throw new Error("boom");
        return item;
      },
    });
    expect(results).toEqual([
      { kind: "failed", error: "boom" },
      { kind: "done", value: "b" },
    ]);
  });
});
