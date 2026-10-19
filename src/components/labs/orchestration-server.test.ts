// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Viewer } from "#learn/retrieve/types";

import { treeRecording } from "@/core/agent/orchestrate-recorded";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

import { listTreeRuns, replayRecordedTree, runTree } from "./orchestration-server";

describe("the recorded tree", () => {
  it("replays Grace's comparison: two children of 28,824 tokens, 13,116 spent between them, 43,217 left", async () => {
    const result = await replayRecordedTree(60_000);
    if ("error" in result) throw new Error(result.error);
    const { parent, children } = result.tree;
    expect(parent).toMatchObject({
      status: "succeeded",
      used: { modelTurns: 3, tokens: 16_783, toolCalls: 7 },
      children: { tokens: 13_116, toolCalls: 4 },
      counted: { tokens: 13_116, toolCalls: 4 },
      left: { tokens: 43_217, toolCalls: 23 },
    });
    expect(children.map((c) => [c.text.slice(0, 33), c.caps.tokens, c.caps.toolCalls, c.used.tokens])).toEqual([
      ["Find and read version 1 of the tr", 28_824, 13, 6_394],
      ["Find and read version 2 of the tr", 28_824, 13, 6_722],
    ]);
  });

  it("at 8,000 tokens, shows both children and then the parent stopped at their caps", async () => {
    const result = await replayRecordedTree(8_000);
    if ("error" in result) throw new Error(result.error);
    expect(result.tree.children.map((c) => [c.status, c.reason])).toEqual([
      ["failed", "cap reached: 2824 tokens"],
      ["failed", "cap reached: 2824 tokens"],
    ]);
    expect(result.tree.parent).toMatchObject({
      status: "failed",
      reason: "cap reached: 8000 tokens",
      left: { tokens: 0 },
    });
  });
});

describe.skipIf(!postgresAvailable)("the viewer's own run trees", () => {
  let t: TestDatabase;
  let grace: Viewer;
  let nora: Viewer;
  const recording = treeRecording();

  beforeAll(async () => {
    t = await createTestDatabase();
    const [{ id: kestrel }] = await t.sql`
      INSERT INTO organization (name, slug, created_at) VALUES ('Kestrel Pay', 'kestrel', now()) RETURNING id`;
    grace = { tenantId: kestrel, userId: recording.viewer.userId };
    nora = { tenantId: kestrel, userId: "55555555-5555-4555-8555-555555555555" };
    for (const [id, name] of [
      [grace.userId, "grace.adeyemi"],
      [nora.userId, "nora.diaz"],
    ]) {
      await t.sql`INSERT INTO principals (id, tenant_id, kind, external_id, name, display_name, enabled, synced_at)
                  VALUES (${id}, ${kestrel}, 'user', ${id}, ${name}, ${name}, true, now())`;
    }
    const runs = [
      { id: recording.runId, parent: null, kind: "chat", caps: {}, events: recording.events },
      ...recording.children.map((c) => ({
        id: c.runId,
        parent: recording.runId,
        kind: "subagent",
        caps: c.caps,
        events: c.events,
      })),
    ];
    for (const run of runs) {
      await t.sql`
        INSERT INTO runs (id, tenant_id, user_id, parent_run_id, kind, status, version, caps, created_at)
        VALUES (${run.id}, ${kestrel}, ${grace.userId}, ${run.parent}, ${run.kind}, 'succeeded', ${run.events.length},
          ${JSON.stringify(run.caps)}::jsonb, ${run.events[0].at})`;
      for (const event of run.events) {
        await t.sql`
          INSERT INTO run_events (tenant_id, run_id, seq, at, type, data)
          VALUES (${kestrel}, ${run.id}, ${event.seq}, ${event.at}, ${event.data.type}, ${JSON.stringify(event.data)}::jsonb)`;
      }
    }
  }, 60_000);

  afterAll(async () => {
    await t?.drop();
  });

  it("lists the runs that delegated, the viewer's only", async () => {
    expect(await listTreeRuns(t.appDb, grace)).toEqual([
      expect.objectContaining({ id: recording.runId, status: "succeeded", children: 2 }),
    ]);
    expect(await listTreeRuns(t.appDb, nora)).toEqual([]);
  });

  it("reads a tree from Postgres with each child's caps, spend and task, and the parent's cap left", async () => {
    const result = await runTree(t.appDb, grace, recording.runId);
    if (!result || "error" in result) throw new Error("no tree");
    expect(result.tree.parent).toMatchObject({
      text: recording.message,
      used: { tokens: 16_783, toolCalls: 7 },
      left: { tokens: 43_217, toolCalls: 23 },
    });
    expect(result.tree.children.map((c) => [c.caps.tokens, c.used.tokens, c.text.startsWith("Find and read")])).toEqual(
      expect.arrayContaining([
        [28_824, 6_394, true],
        [28_824, 6_722, true],
      ]),
    );
    expect(await runTree(t.appDb, nora, recording.runId), "someone else's run is not found").toBeNull();
  });
});
