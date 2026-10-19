// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RunEvent, RunStatus } from "#learn/agent/types";

import { resumeFrom, type RunTail, tailEvents, toSse, toTokenSse } from "#learn/agent/stream";
import {
  appendsOf,
  loadRecorded,
  recordedEvents,
  recordedRun,
  stateWorld,
  type StateWorld,
} from "@/core/agent/state-testing";
import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";
import { append } from "@/lib/agent-runs";
import { handleStream } from "@/routes/api/runs/-runs";

const kpc = recordedEvents("kpc-email");
const ev = (seq: number) => ({ seq });

/** A log in memory that a test can append to, with the status the appends leave. */
function fakeLog(pageSize = 500) {
  const events: { seq: number }[] = [];
  let status: RunStatus | null = "running";
  const calls: string[] = [];
  const log = {
    events,
    calls,
    set status(next: RunStatus | null) {
      status = next;
    },
    /** An append: events and status land together, as one statement makes them. */
    commit(seqs: number[], next: RunStatus | null = status) {
      events.push(...seqs.map(ev));
      status = next;
    },
    /** Runs once, right after the first read of either kind returns: an append landing between two reads. */
    between: null as null | (() => void),
    tail: {
      status: async () => {
        calls.push("status");
        const now = status;
        log.between?.();
        log.between = null;
        return now;
      },
      after: async (seq: number) => {
        calls.push(`after ${seq}`);
        const now = events.filter((e) => e.seq > seq).slice(0, pageSize);
        log.between?.();
        log.between = null;
        return now;
      },
    } satisfies RunTail<{ seq: number }>,
  };
  return log;
}

/** Everything a tail yields, page by page, failing if it takes longer than `ms` (and then stopping it). */
async function drain<E>(tail: AsyncGenerator<E[]>, ms = 2_000, what = "the tail"): Promise<E[][]> {
  const pages: E[][] = [];
  const deadline = Date.now() + ms;
  for (;;) {
    const late = new Promise<"late">((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now()), "late"));
    const next = await Promise.race([tail.next(), late]);
    if (next === "late" || (!next.done && pages.length > 50)) {
      void tail.return([]);
      expect.fail(
        `${what} didn't end within ${ms} ms (${pages.length} pages so far${pages.length > 50 ? ": is the cursor moving?" : ""})`,
      );
    }
    if (next.done) return pages;
    pages.push(next.value);
  }
}

describe("the wire format", () => {
  it("sends an event as `id: <seq>` and one `data:` line of its JSON, then a blank line", () => {
    const event = kpc[12];
    expect(toSse(event)).toBe(`id: 13\ndata: ${JSON.stringify(event)}\n\n`);
    const multiline = recordedEvents("lost-plan").find((e) => e.seq === 20)!;
    expect(multiline.data.type === "assistant_turn" && multiline.data.text).toContain("\n");
    expect(
      toSse(multiline)
        .split("\n")
        .filter((line) => line.startsWith("data: ")),
      "a text with newlines is still one data line",
    ).toHaveLength(1);
  });

  it("sends a token with no id, so Last-Event-ID always names a stored event", () => {
    expect(toTokenSse("Emailed")).toBe('event: token\ndata: {"delta":"Emailed"}\n\n');
  });
});

describe("where a stream starts", () => {
  it("starts after Last-Event-ID, else after ?after=, else at the top", () => {
    expect(resumeFrom("15", "12"), "the browser's own reconnect is newer than the URL it opened").toBe(15);
    expect(resumeFrom(null, "12"), "a reload says where it was in ?after=").toBe(12);
    expect(resumeFrom(null, null)).toBe(0);
    expect(resumeFrom(" 7 ", null)).toBe(7);
  });

  it("treats a value that isn't a seq as absent", () => {
    expect(resumeFrom("abc", "12"), "a header that isn't a seq falls back to the query").toBe(12);
    expect(resumeFrom("-1", null)).toBe(0);
    expect(resumeFrom("1.5", null)).toBe(0);
    expect(resumeFrom("", "")).toBe(0);
    expect(resumeFrom("1234567890", null), "more than 9 digits isn't a seq").toBe(0);
  });
});

describe("tailing a log", () => {
  it("starts after `from`, moves its cursor to the last event sent, and ends once the run is final", async () => {
    const log = fakeLog();
    log.commit([1, 2, 3, 4], "succeeded");
    const pages = await drain(tailEvents(log.tail, 2, { pollMs: 5 }));
    expect(
      pages.flat().map((e) => e.seq),
      "what came after seq 2, all of it, though the run is already final",
    ).toEqual([3, 4]);
    expect(
      log.calls.filter((c) => c.startsWith("after")),
      "after a page, ask for what's after its last seq",
    ).toEqual(["after 2", "after 4"]);
  });

  it("reads the status before the events, so an append landing in between can't end the stream early", async () => {
    const log = fakeLog();
    log.commit([1, 2]);
    const tail = tailEvents(log.tail, 2, { pollMs: 5 });
    // Seq 3 and the final status commit together, after your first read and before your second.
    log.between = () => log.commit([3], "succeeded");
    const pages = await drain(tail);
    expect(
      pages.flat().map((e) => e.seq),
      "the stream ended without seq 3: it read the events, then a final status written with seq 3. Read the status first, then the events",
    ).toEqual([3]);
  });

  it("drains every page of a finished run without waiting between pages", async () => {
    const log = fakeLog(2);
    log.commit([1, 2, 3, 4, 5], "succeeded");
    const pages = await drain(
      tailEvents(log.tail, 0, { pollMs: 60_000 }),
      1_000,
      "a finished run's five events, two a page,",
    );
    expect(
      pages.map((p) => p.map((e) => e.seq)),
      "a final status ends the stream only once no events are left",
    ).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("waits a poll between looks while the run is live and quiet, and sends what lands", async () => {
    const log = fakeLog();
    log.commit([1]);
    const tail = tailEvents(log.tail, 1, { pollMs: 20 });
    const next = tail.next();
    await new Promise((resolve) => setTimeout(resolve, 110));
    const looks = log.calls.filter((c) => c === "status").length;
    expect(looks, `it looked ${looks} times in 110 ms: wait pollMs between looks`).toBeLessThan(12);
    expect(looks, "it should keep looking while the run is live").toBeGreaterThan(1);
    log.commit([2, 3]);
    expect((await next).value?.map((e: { seq: number }) => e.seq)).toEqual([2, 3]);
    log.status = "cancelled";
    expect((await tail.next()).done).toBe(true);
  });

  it("ends when the run is gone, and when the signal aborts while it waits", async () => {
    const gone = fakeLog();
    gone.status = null;
    expect(await drain(tailEvents(gone.tail, 0, { pollMs: 5 }))).toEqual([]);

    const live = fakeLog();
    const stop = new AbortController();
    const tail = tailEvents(live.tail, 0, { pollMs: 60_000, signal: stop.signal });
    const pages = drain(tail, 1_000, "an aborted tail");
    await new Promise((resolve) => setTimeout(resolve, 30));
    stop.abort();
    expect(await pages).toEqual([]);
  });
});

describe.skipIf(!postgresAvailable)("the worked example: Leo's run through the real route", () => {
  let t: TestDatabase;
  let world: StateWorld;
  const KPC = recordedRun("kpc-email").run.id;

  interface Block {
    id?: string;
    event?: string;
    data?: string;
  }
  async function read(response: Response, until: (blocks: Block[]) => boolean = () => false) {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const blocks: Block[] = [];
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return { blocks, ended: true };
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const block: Block = {};
        for (const line of buffer.slice(0, end).split("\n")) {
          if (line.startsWith("id: ")) block.id = line.slice(4);
          else if (line.startsWith("event: ")) block.event = line.slice(7);
          else if (line.startsWith("data: ")) block.data = line.slice(6);
        }
        buffer = buffer.slice(end + 2);
        if (block.data) blocks.push(block);
      }
      if (until(blocks)) {
        await reader.cancel();
        return { blocks, ended: false };
      }
    }
  }
  const seqs = (blocks: Block[]) => blocks.map((b) => (JSON.parse(b.data!) as RunEvent).seq);
  const open = (headers: HeadersInit = {}, query = "") =>
    handleStream(
      new Request(`http://localhost:3000/api/runs/${KPC}/stream${query}`, { headers }),
      world.viewerOf("kpc-email"),
      KPC,
      { db: t.appDb, kick: () => {}, pollMs: 10 },
    );
  /** The rest of the recorded run, appended as it was: seq 13 to 17 in five appends. */
  const finish = () =>
    withTenantOn(t.appDb, world.tenantId, async (tx) => {
      let version = 10;
      for (const batch of appendsOf(recordedRun("kpc-email").events.filter((e) => e.seq > 12))) {
        version = (
          await append(
            tx,
            KPC,
            version,
            batch.map((e) => e.data),
          )
        ).version;
      }
    });

  beforeAll(async () => {
    t = await createTestDatabase();
    world = await stateWorld(t.sql);
  });

  afterAll(async () => {
    await t?.drop();
  });

  it("sends seq 1 to 12 from the top with id = seq, then 13 to 17 as they land, and ends at succeeded", async () => {
    await loadRecorded(t.sql, world, "kpc-email", { throughSeq: 12 });
    const reading = read(await open());
    await new Promise((resolve) => setTimeout(resolve, 100));
    await finish();
    const { blocks, ended } = await reading;
    expect(
      blocks.map((b) => b.id),
      "each event's SSE id is its seq",
    ).toEqual(kpc.map((e) => String(e.seq)));
    expect(seqs(blocks)).toEqual(kpc.map((e) => e.seq));
    expect(ended, "the run is final and everything is sent: the stream ends").toBe(true);
  });

  it("after a reload (?after=12) sends 13 to 17 only; after the browser's reconnect (Last-Event-ID: 15) only 16 and 17", async () => {
    await loadRecorded(t.sql, world, "kpc-email");
    const reload = await read(await open({}, "?after=12"));
    expect(seqs(reload.blocks), "a reload that held 12 events gets the 5 it missed").toEqual([13, 14, 15, 16, 17]);
    const reconnect = await read(await open({ "last-event-id": "15" }, "?after=12"));
    expect(seqs(reconnect.blocks), "the reconnect's Last-Event-ID (15) is newer than the URL's ?after=12").toEqual([
      16, 17,
    ]);
  });
});
