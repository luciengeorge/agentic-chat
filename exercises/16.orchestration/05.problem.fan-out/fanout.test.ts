// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type Admission, fanOut } from "#learn/agent/fanout";

/** Children that run until the test finishes them, counting how many run at once. */
function children<T>() {
  const started: T[] = [];
  const finish = new Map<T, { done: (value: string) => void; fail: (error: Error) => void }>();
  let running = 0;
  let peak = 0;
  const run = (item: T) =>
    new Promise<string>((resolve, reject) => {
      started.push(item);
      running += 1;
      peak = Math.max(peak, running);
      finish.set(item, {
        done: (value) => {
          running -= 1;
          resolve(value);
        },
        fail: (error) => {
          running -= 1;
          reject(error);
        },
      });
    });
  return { started, finish, run, peak: () => peak, running: () => running };
}

/** Lets every pending promise callback run, with no timer. */
async function settle(rounds = 50) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("fanOut", () => {
  it("never runs more than the limit at once; the rest wait, in item order", async () => {
    const c = children<number>();
    const done = fanOut([0, 1, 2, 3, 4, 5], { limit: 2, run: c.run });
    await settle();
    expect(c.started, "Promise.all over every item starts all six at once: start only `limit`").toEqual([0, 1]);
    c.finish.get(0)!.done("a");
    await settle();
    expect(c.started, "one finished: the next waiting item starts, in item order").toEqual([0, 1, 2]);
    c.finish.get(1)!.done("b");
    await settle();
    c.finish.get(2)!.done("c");
    c.finish.get(3)!.done("d");
    await settle();
    expect(c.started).toEqual([0, 1, 2, 3, 4, 5]);
    c.finish.get(4)!.done("e");
    c.finish.get(5)!.done("f");
    expect((await done).map((r) => r.kind)).toEqual(Array(6).fill("done"));
    expect(c.peak(), "two at most, ever").toBe(2);
  });

  it("refills a slot as soon as it frees, without waiting for the rest of a batch", async () => {
    const c = children<string>();
    const done = fanOut(["a", "b", "c", "d"], { limit: 3, run: c.run });
    await settle();
    c.finish.get("b")!.done("B");
    await settle();
    expect(
      c.started,
      "b finished while a and c still run: d starts now. Batches of 3 would leave the slot empty until a and c end",
    ).toEqual(["a", "b", "c", "d"]);
    for (const item of ["a", "c", "d"]) c.finish.get(item)!.done(item.toUpperCase());
    expect(await done).toEqual(["A", "B", "C", "D"].map((value) => ({ kind: "done", value })));
  });

  it("returns each item's result in item order, whatever order they finished in", async () => {
    const c = children<number>();
    const done = fanOut([0, 1, 2], { limit: 3, run: c.run });
    await settle();
    c.finish.get(2)!.done("third");
    c.finish.get(0)!.done("first");
    c.finish.get(1)!.done("second");
    expect(await done, "results[i] is item i's result, not the i-th to finish").toEqual([
      { kind: "done", value: "first" },
      { kind: "done", value: "second" },
      { kind: "done", value: "third" },
    ]);
  });

  it("keeps going past a child that fails, and says why it failed", async () => {
    const results = await fanOut(["a", "b", "c"], {
      limit: 1,
      run: async (item) => {
        if (item === "b") throw new Error("search_documents timed out after 30 s.");
        return item;
      },
    }).catch((error: Error) => `fanOut threw: ${error.message}`);
    expect(results, 'a child that throws is `{ kind: "failed", error }`, and the next one still starts').toEqual([
      { kind: "done", value: "a" },
      { kind: "failed", error: "search_documents timed out after 30 s." },
      { kind: "done", value: "c" },
    ]);
  });

  it("asks before each start, and once told no, skips every item not yet started", async () => {
    const asked: number[] = [];
    let open = true;
    const c = children<number>();
    const done = fanOut([0, 1, 2, 3, 4], {
      limit: 2,
      admit: async (_, index): Promise<Admission> => {
        asked.push(index);
        return open ? { go: true } : { go: false, reason: "kill switch: agents are switched off" };
      },
      run: c.run,
    });
    await settle();
    expect(asked, "ask before each child starts").toEqual([0, 1]);
    open = false;
    c.finish.get(0)!.done("a");
    await settle();
    expect(c.started, "item 2 was refused: it must not start").toEqual([0, 1]);
    expect(c.running(), "item 1 is still running: a refusal doesn't stop a child that started").toBe(1);
    c.finish.get(1)!.done("b");
    const results = await done;
    expect(results).toEqual([
      { kind: "done", value: "a" },
      { kind: "done", value: "b" },
      { kind: "skipped", reason: "kill switch: agents are switched off" },
      { kind: "skipped", reason: "kill switch: agents are switched off" },
      { kind: "skipped", reason: "kill switch: agents are switched off" },
    ]);
    expect(asked, "once refused, don't ask again: the rest are skipped with the same reason").toEqual([0, 1, 2]);
  });

  it("runs on promises alone: no timer, so a workflow replay starts children in the same order", async () => {
    vi.useFakeTimers();
    const done = fanOut([1, 2, 3, 4, 5], { limit: 2, run: async (n) => n * 10 });
    const outcome = await Promise.race([done, settle(500).then(() => "stuck" as const)]);
    expect(outcome, "with the clock stopped it still finishes: don't wait on setTimeout or setInterval").not.toBe(
      "stuck",
    );
  });

  it("treats a limit below 1 as 1, and a fraction as its whole part", async () => {
    const zero = children<number>();
    const doneZero = fanOut([0, 1], { limit: 0, run: zero.run });
    await settle();
    expect(zero.started, "a limit of 0 would never start anything: run at least one").toEqual([0]);
    zero.finish.get(0)!.done("a");
    await settle();
    zero.finish.get(1)!.done("b");
    await doneZero;

    const half = children<number>();
    const doneHalf = fanOut([0, 1, 2], { limit: 2.5, run: half.run });
    await settle();
    expect(half.started, "2.5 children at once is 2").toEqual([0, 1]);
    for (const i of [0, 1]) half.finish.get(i)!.done("x");
    await settle();
    half.finish.get(2)!.done("x");
    await doneHalf;
    expect(await fanOut([], { limit: 3, run: async () => "x" }), "no items, no results").toEqual([]);
  });
});

/** The six documents in /Company, in the order claimFire lists them (by path, in the database's en_US order). */
function companyDocuments(): string[] {
  const manifest = JSON.parse(readFileSync("fixtures/corpus/build/manifest.json", "utf8")) as {
    sites: { kestrel: { items: Array<{ path: string; kind?: string; type?: string }> } };
  };
  return manifest.sites.kestrel.items
    .map((item) => item.path)
    .filter((path) => /^\/Company\/[^/]+\.\w+$/.test(path))
    .sort((a, b) => a.localeCompare(b, "en"));
}

describe("Grace's Monday digest of /Company, three at a time", () => {
  it("runs 3 of the 6, refills each slot as it frees, and skips the last once the kill switch is on", async () => {
    const titles = companyDocuments().map((path) => path.slice("/Company/".length));
    expect(titles).toEqual([
      "2026 Holiday Calendar.pdf",
      "Brightwell Payroll Partner Onboarding Pack v1.3.docx",
      "Code of Conduct.pdf",
      "Kestrel Pay Employee Handbook 2026.docx",
      "new-starter-checklist.md",
      "Office Guide.pdf",
    ]);
    const [calendar, brightwell, conduct, handbook, checklist, office] = titles;
    let killed = false;
    const c = children<string>();
    const done = fanOut(titles, {
      limit: 3,
      admit: async () => (killed ? { go: false, reason: "kill switch: agents are switched off" } : { go: true }),
      run: c.run,
    });

    await settle();
    expect(c.started, "three start; the other three queue").toEqual([calendar, brightwell, conduct]);
    c.finish.get(conduct)!.done("summary");
    await settle();
    expect(c.started, "the Code of Conduct run ends first: the Handbook takes its slot at once").toEqual([
      calendar,
      brightwell,
      conduct,
      handbook,
    ]);
    c.finish.get(calendar)!.done("summary");
    await settle();
    expect(c.started.at(-1)).toBe(checklist);

    killed = true; // Someone throws the kill switch.
    c.finish.get(brightwell)!.done("summary");
    await settle();
    expect(c.started, "the Office Guide is refused before it starts").not.toContain(office);
    c.finish.get(handbook)!.done("summary");
    c.finish.get(checklist)!.done("summary");

    const results = await done;
    expect(results.map((r) => r.kind)).toEqual(["done", "done", "done", "done", "done", "skipped"]);
    expect(results[5]).toEqual({ kind: "skipped", reason: "kill switch: agents are switched off" });
    expect(c.peak(), "never more than 3 runs of the fire at once").toBe(3);
  });
});
