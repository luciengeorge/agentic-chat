// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";
import { loadState } from "@/lib/agent-runs";

import { statusOf } from "./state";
import {
  appendsOf,
  lastStatus,
  loadRecorded,
  RECORDED_RUNS,
  recordedEvents,
  recordedRun,
  stateWorld,
} from "./state-testing";
import { resumeFrom, tailEvents } from "./stream";

describe("the recorded runs", () => {
  it.each(RECORDED_RUNS)(
    "%s: its appends (events sharing an `at`) count to its version, and its log folds to its status",
    (name) => {
      const { run, events } = recordedRun(name);
      expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
      expect(appendsOf(events)).toHaveLength(run.version);
      expect(lastStatus(events)).toBe(run.status);
      expect(statusOf(events)).toBe(run.status);
    },
  );
});

describe("the stream's pieces", () => {
  it("starts after Last-Event-ID, else ?after=, else 0", () => {
    expect(resumeFrom("15", "12")).toBe(15);
    expect(resumeFrom("x", "12")).toBe(12);
    expect(resumeFrom(null, null)).toBe(0);
  });

  it("reads the status before the events, so a final append between the reads still gets sent", async () => {
    const log = [{ seq: 1 }];
    let status: "running" | "succeeded" = "running";
    let landed = false;
    const land = () => {
      if (landed) return;
      landed = true;
      log.push({ seq: 2 });
      status = "succeeded";
    };
    const pages: number[][] = [];
    for await (const page of tailEvents(
      {
        status: async () => {
          const now = status;
          land();
          return now;
        },
        after: async (seq) => log.filter((e) => e.seq > seq),
      },
      1,
      { pollMs: 1 },
    )) {
      pages.push(page.map((e) => e.seq));
    }
    expect(pages).toEqual([[2]]);
  });
});

describe.skipIf(!postgresAvailable)("loading a recorded run", () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
  });

  afterAll(async () => {
    await t?.drop();
  });

  it("writes the run as it stood at a seq, which the run service reads back as recorded", async () => {
    const world = await stateWorld(t.sql);
    const loaded = await loadRecorded(t.sql, world, "kpc-email", { throughSeq: 12 });
    expect(loaded).toMatchObject({ version: 10, status: "waiting" });
    const state = await withTenantOn(t.appDb, world.tenantId, (tx) => loadState(tx, loaded.viewer, loaded.runId));
    expect(state?.run).toMatchObject({ status: "waiting", version: 10, finishedAt: null });
    expect(state?.events).toEqual(recordedEvents("kpc-email", 12));
  });
});
