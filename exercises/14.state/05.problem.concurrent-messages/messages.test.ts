// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RunEventData, RunStatus } from "#learn/agent/types";

import { addMessage, appendRetrying } from "#learn/agent/messages";
import { loadRecorded, recordedRun, stateWorld, type StateWorld } from "@/core/agent/state-testing";
import { type Tx, withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";
import { append } from "@/lib/agent-runs";

const KPC = recordedRun("kpc-email").run.id;
const LEO = recordedRun("kpc-email").run.userId;
const AMARA = { messageId: "b7d0e6a2-4f0e-4b8e-9d1c-2f3a4b5c6d7e", text: "Copy Amara Okafor too." };
const TERMS = { messageId: "c1e2f3a4-b5c6-4d7e-8f90-a1b2c3d4e5f6", text: "Mention the 30-day terms." };
const approved: RunEventData = {
  type: "approval_decided",
  approvalId: "71fc5274-520c-4915-a879-ede8e0499b24",
  decision: "approved",
  by: LEO,
};

/** What went wrong, in the words of the mistake that usually causes it. */
function explain(error: unknown): string | null {
  if (!error) return null;
  const text = `${String(error)} ${String((error as { cause?: unknown }).cause ?? "")}`;
  if (/is at version/.test(text)) {
    return `a writer lost the version race and gave up (${text.slice(0, 90)}): read the run again, build again and append after the winner`;
  }
  if (/23505|duplicate key|message_id_key/.test(text)) {
    return "the message's id was already stored and the insert hit the unique index: look the id up first (messageSeq) and answer duplicate; when two sends overlap, catch the 23505 and run the transaction again";
  }
  return text.slice(0, 200);
}
const attempt = <T>(promise: Promise<T>) => promise.catch((error: unknown) => ({ error }));
const failure = (result: unknown) =>
  explain(result && typeof result === "object" && "error" in result ? (result as { error: unknown }).error : null);
/** Fails with the explanation when any of the results is an error. */
function expectLanded(...results: unknown[]) {
  const why = results.map(failure).find(Boolean) ?? null;
  expect(why, why ?? "").toBeNull();
}

describe.skipIf(!postgresAvailable)("concurrent messages", () => {
  let t: TestDatabase;
  let world: StateWorld;
  const leo = () => world.viewerOf("kpc-email");

  const log = (id = KPC) =>
    t.sql<{ seq: number; type: string; message_id: string | null }[]>`
      SELECT seq, type, data ->> 'messageId' AS message_id FROM run_events WHERE run_id = ${id} ORDER BY seq`;
  const run = async (id = KPC) =>
    (await t.sql<{ status: RunStatus; version: number }[]>`SELECT status, version FROM runs WHERE id = ${id}`)[0];
  /** Leo's run as it stood waiting on his approval: seq 12, version 10. */
  const waiting = () => loadRecorded(t.sql, world, "kpc-email", { throughSeq: 12 });

  /**
   * Holds the run's row locked in another transaction until `release()`: writers that start meanwhile do their
   * reads, then wait at their UPDATE, so they all race when it's released.
   */
  async function holdRun(id = KPC) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = t.sql.begin(async (sql) => {
      await sql`SELECT 1 FROM runs WHERE id = ${id} FOR UPDATE`;
      locked();
      await released;
    });
    await isLocked;
    return {
      async release() {
        await new Promise((resolve) => setTimeout(resolve, 250));
        release();
        await holder;
      },
    };
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    world = await stateWorld(t.sql);
  });

  afterAll(async () => {
    await t?.drop();
  });

  describe("appendRetrying", () => {
    it("reads the run again after a conflict and builds its events from what it finds", async () => {
      await waiting();
      const seen: RunStatus[] = [];
      let slipped = false;
      // A writer slips in right after your first read: the approval resumes the run (waiting -> running).
      const slipIn = async () => {
        if (slipped) return;
        slipped = true;
        await withTenantOn(t.appDb, world.tenantId, (tx) =>
          append(tx, KPC, 10, [approved, { type: "status", from: "waiting", to: "running" }]),
        );
      };
      const appended = await withTenantOn(t.appDb, world.tenantId, (tx) => {
        const racy = new Proxy(tx, {
          get(target, key, receiver) {
            if (key !== "execute") return Reflect.get(target, key, receiver);
            return async (...args: Parameters<Tx["execute"]>) => {
              const result = await target.execute(...args);
              await slipIn();
              return result;
            };
          },
        });
        // Leo cancels: from whatever the run is in now.
        return appendRetrying(racy, KPC, ({ status }) => {
          seen.push(status);
          return [{ type: "status", from: status, to: "cancelled", reason: "cancelled by the user" }];
        });
      }).catch((error: unknown) => error);
      expect(slipped, "read the run with tx.execute, so the test can slip a writer in after your read").toBe(true);
      expect(
        appended instanceof Error ? appended.message : null,
        "after a conflict, read the run again and call build again: the run moved from waiting to running",
      ).toBeNull();
      expect(seen, "build sees the run as read before each try: waiting, then (after the conflict) running").toEqual([
        "waiting",
        "running",
      ]);
      expect(await run(), "the cancel landed from the status the run was really in").toMatchObject({
        status: "cancelled",
        version: 12,
      });
    });

    it("appends nothing and returns null when build says there's nothing to write", async () => {
      await loadRecorded(t.sql, world, "kpc-email");
      const result = await withTenantOn(t.appDb, world.tenantId, (tx) =>
        appendRetrying(tx, KPC, ({ status }) => (status === "succeeded" ? null : [approved])),
      );
      expect(result).toBeNull();
      expect((await log()).length).toBe(17);
    });
  });

  describe("addMessage", () => {
    it("adds a message at the next seq, and a resend with the same id stores nothing and answers with that seq", async () => {
      await waiting();
      expect(await addMessage(t.appDb, leo(), KPC, AMARA)).toEqual({ kind: "added", seq: 13, status: "waiting" });
      const resend = await attempt(addMessage(t.appDb, leo(), KPC, AMARA));
      expectLanded(resend);
      expect(resend, "the same messageId again is a resend: look it up first (messageSeq)").toEqual({
        kind: "duplicate",
        seq: 13,
        status: "waiting",
      });
      expect((await log()).filter((r) => r.message_id === AMARA.messageId)).toHaveLength(1);
    });

    it("keys on the id, not the words: two messages that say the same thing both land", async () => {
      await waiting();
      await addMessage(t.appDb, leo(), KPC, { messageId: "yes-1", text: "Yes." });
      const second = await addMessage(t.appDb, leo(), KPC, { messageId: "yes-2", text: "Yes." });
      expect(second, "Leo said Yes. twice, with two ids: that's two messages").toMatchObject({
        kind: "added",
        seq: 14,
      });
    });

    it("refuses a finished run, someone else's and one that isn't there, storing nothing", async () => {
      await loadRecorded(t.sql, world, "kpc-email");
      expect(
        await addMessage(t.appDb, leo(), KPC, AMARA),
        "the run succeeded at seq 17: a message can't go in",
      ).toEqual({ kind: "finished", status: "succeeded" });
      expect((await log()).length).toBe(17);
      const tom = world.viewerOf("cancel-waiting");
      expect(await addMessage(t.appDb, tom, KPC, AMARA), "Leo's run isn't Tom's").toEqual({ kind: "not-found" });
      expect(await addMessage(t.appDb, leo(), crypto.randomUUID(), AMARA)).toEqual({ kind: "not-found" });
    });

    it("stores the same message sent twice at once once: one is added, the other answers duplicate", async () => {
      await waiting();
      const held = await holdRun();
      const both = Promise.all([
        attempt(addMessage(t.appDb, leo(), KPC, AMARA)),
        attempt(addMessage(t.appDb, leo(), KPC, AMARA)),
      ]);
      await held.release();
      const results = await both;
      expectLanded(...results);
      expect(results.map((r) => (r as { kind: string }).kind).sort()).toEqual(["added", "duplicate"]);
      expect(
        results.map((r) => (r as { seq: number }).seq),
        "both answers name the one stored seq",
      ).toEqual([13, 13]);
      expect((await log()).filter((r) => r.message_id === AMARA.messageId)).toHaveLength(1);
    });
  });

  describe("the worked example: the approval and two follow-ups at once, then a resend", () => {
    it("lands all three at seq 13 to 15, once each, at version 13; the resend stores nothing", async () => {
      await waiting();
      expect(await run()).toMatchObject({ status: "waiting", version: 10 });
      const held = await holdRun();
      const writes = Promise.all([
        attempt(
          withTenantOn(t.appDb, world.tenantId, (tx) =>
            appendRetrying(tx, KPC, ({ status }) => (status === "waiting" ? [approved] : null)),
          ),
        ),
        attempt(addMessage(t.appDb, leo(), KPC, AMARA)),
        attempt(addMessage(t.appDb, leo(), KPC, TERMS)),
      ]);
      await held.release();
      expectLanded(...(await writes));

      const after = await log();
      expect(
        after.map((r) => r.seq),
        "no gaps, no doubles",
      ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
      expect(
        after
          .slice(12)
          .map((r) => r.message_id ?? r.type)
          .sort(),
      ).toEqual([AMARA.messageId, TERMS.messageId, "approval_decided"].sort());
      expect(await run(), "three appends after version 10").toMatchObject({ status: "waiting", version: 13 });

      const amaraSeq = after.find((r) => r.message_id === AMARA.messageId)!.seq;
      const resend = await attempt(addMessage(t.appDb, leo(), KPC, AMARA));
      expectLanded(resend);
      expect(resend, "the browser's resend, after the signal came back").toEqual({
        kind: "duplicate",
        seq: amaraSeq,
        status: "waiting",
      });
      expect((await log()).length).toBe(15);
    });
  });
});
