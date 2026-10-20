// @vitest-environment node
// Each drill's live side (what it plants, how it checks the symptom, how it undoes) against the ACL test world:
// a throwaway database synced from an in-process fake-workspace. Never the dev database.
import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { Fault } from "@/core/drills/types";

import { WORLD_EMBEDDER, setupAclWorld } from "@/core/acl/testing";
import { DRILLS } from "@/core/drills/catalog";
import { unseal } from "@/core/drills/seal";
import { postgresAvailable } from "@/db/testing";

import { createApp } from "../../servers/fake-workspace/app";
import { FAST, ManualClock } from "../../servers/fake-workspace/testing";
import { fill, fillAction, fillProbe, type Live, type Vars, varNames } from "./drill";
import { clockOnUtc, createLive, type LiveOptions, localInstant, scheduleProblems } from "./drill-live";

const fault = (id: string) => unseal<Fault>(id, DRILLS.find((drill) => drill.id === id)!.sealed);
const NOW = new Date(2026, 9, 20, 9, 15);

describe("drill-live helpers", () => {
  const saved = process.env.TZ;
  afterEach(() => {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  });

  it("finds a time on the machine's clock, and whether that clock is UTC all year", () => {
    process.env.TZ = "Europe/Paris";
    expect(localInstant(new Date("2026-10-20T07:15:00Z"), "02:30", -1).toISOString()).toBe("2026-10-19T00:30:00.000Z");
    expect(clockOnUtc(2026)).toBe(false);
    process.env.TZ = "UTC";
    expect(clockOnUtc(2026)).toBe(true);
  });

  it("names what's wrong with a schedule's next fires", () => {
    const daily = (after: Date) =>
      new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate() + 1, 2, 30));
    expect(scheduleProblems(daily, new Date("2026-10-20T12:00:00Z"), "02:30", 30)).toEqual([]);
    const early = (after: Date) => new Date(daily(after).getTime() - 2 * 3600_000);
    expect(scheduleProblems(early, new Date("2026-10-20T12:00:00Z"), "02:30", 2)).toEqual([
      "it fires at 00:30 UTC on 2026-10-21",
      "it fires at 00:30 UTC on 2026-10-22",
    ]);
  });
});

describe.skipIf(!postgresAvailable)("each drill's live side, on the ACL test world", () => {
  const world = setupAclWorld({ chunks: true });
  const { app, runtime } = createApp({ env: "dev", clock: new ManualClock(), policy: FAST });
  const fetch = (async (url: string | URL | Request, init?: RequestInit) =>
    app.fetch(new Request(url, init))) as typeof globalThis.fetch;
  afterAll(async () => {
    await runtime.notifier.close();
  });

  let lives: Live[] = [];
  afterEach(async () => {
    for (const live of lives) await live.close();
    lives = [];
  });

  function live(extra: Partial<LiveOptions> = {}): Live {
    const w = world.get();
    const env = {
      AC_ENV: "test",
      DATABASE_ADMIN_URL: w.t.url,
      DATABASE_URL: w.t.appUrl,
      FAKE_WORKSPACE_URL: "http://fw",
    };
    const made = createLive({ env, fetch, now: () => NOW, ...extra });
    lives.push(made);
    return made;
  }

  /** What `ex drill <id>` does to the stack, minus the code. */
  async function plant(l: Live, f: Fault): Promise<Vars> {
    const vars: Vars = { planted: "09:15" };
    await l.resolve(varNames(f), vars);
    for (const requirement of f.requires) expect(await l.count(fill(requirement.text, vars, "sql"))).toBeGreaterThan(0);
    for (const action of f.plant) await l.act(fillAction(action, vars));
    return vars;
  }
  const undo = async (l: Live, f: Fault, vars: Vars) => {
    for (const action of f.undo) await l.act(fillAction(action, vars));
  };
  const probes = async (l: Live, f: Fault, vars: Vars) => Promise.all(f.probes.map((p) => l.probe(fillProbe(p, vars))));

  it("needs the stack it names", async () => {
    const w = world.get();
    await expect(live().preflight(["database", "workspace"])).resolves.toBeUndefined();
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch;
    await expect(live({ fetch: down }).preflight(["workspace"])).rejects.toThrow("fake-workspace isn't answering");
    await expect(live().preflight(["cohere"])).rejects.toThrow("COHERE_API_KEY isn't set");
    const local = createLive({ env: { COHERE_API_KEY: "test", MODEL_PROVIDER: "local" } });
    lives.push(local);
    await expect(local.preflight(["cohere"])).rejects.toThrow("MODEL_PROVIDER is local");
    const nowhere = createLive({ env: { DATABASE_ADMIN_URL: "postgres://ac:ac@127.0.0.1:1/ac" } });
    lives.push(nowhere);
    await expect(nowhere.preflight(["database"])).rejects.toThrow("ParadeDB isn't answering");
    expect(w.tenants.kestrel).toBeTruthy();
  });

  it("leaver: plants a leaver whom a stale closure keeps reading, and undoes it", async () => {
    const w = world.get();
    const f = fault("leaver");
    const l = live();
    const vars = await plant(l, f);
    const exec = w.group("/Kestrel/Exec");
    const priya = w.user("priya.nair");
    // The reference sync just ran, so she's out everywhere; the fault would have kept her closure row.
    expect(await probes(l, f, vars)).toEqual([
      { ok: true, detail: "" },
      { ok: true, detail: "" },
    ]);
    await w.t
      .sql`INSERT INTO group_closure (tenant_id, group_id, member_id, depth) VALUES (${w.tenants.kestrel}, ${exec}, ${priya}, 1)`;
    const [, stale] = await probes(l, f, vars);
    expect(stale).toEqual({
      ok: false,
      detail: expect.stringContaining("priya.nair can still read the Project Heron board memo"),
    });
    // The learner's fix deployed, and a sync: the closure catches up.
    await l.act(f.plant.find((action) => action.kind === "sync-directory")!);
    expect((await probes(l, f, vars))[1]).toEqual({ ok: true, detail: "" });

    await undo(l, f, vars);
    await undo(l, f, vars);
    const [back, reads] = await probes(l, f, vars);
    expect(back.ok, "priya.nair is in /Kestrel/Exec again").toBe(false);
    expect(reads.ok, "and reads the memo again").toBe(false);
  });

  it("paraphrase: relabels the HR policies' chunks, sees the repair, and undoes it", async () => {
    const w = world.get();
    const f = fault("paraphrase");
    const l = live();
    const vars = await plant(l, f);
    expect(Object.values(vars)).toContain(WORLD_EMBEDDER.version);
    const [hidden] = await probes(l, f, vars);
    expect(hidden).toEqual({
      ok: false,
      detail: expect.stringMatching(/^Kestrel's HR policies still can't be found .* \(\d+ found\)$/),
    });

    // The learner's repair, once the vectors are known to be the app's: their label put right.
    await w.t
      .sql`UPDATE chunks SET embedding_model_version = ${WORLD_EMBEDDER.version} WHERE embedding_model_version <> ${WORLD_EMBEDDER.version}`;
    expect(await probes(l, f, vars)).toEqual([{ ok: true, detail: "" }]);

    // Planted again and undone without a repair: the labels come back.
    await plant(l, f);
    expect((await probes(l, f, vars))[0]!.ok).toBe(false);
    await undo(l, f, vars);
    expect(await probes(l, f, vars)).toEqual([{ ok: true, detail: "" }]);
  });

  it("ranking: passes when the app's reranker answers, fails with its error when it throws", async () => {
    const f = fault("ranking");
    expect(f.plant).toEqual([]);
    const up = live({ reranker: async () => ({ rerank: async () => [] }) });
    expect(await probes(up, f, {})).toEqual([{ ok: true, detail: "" }]);
    const down = live({
      reranker: async () => ({
        rerank: async () => {
          throw new Error("the reranker is down");
        },
      }),
    });
    expect(await probes(down, f, {})).toEqual([
      { ok: false, detail: "The app's reranker still fails: the reranker is down" },
    ]);
  });

  it("stuck-edits: plants a poison sync that blocks Kestrel's partition, sees the relay give up on it, undoes it", async () => {
    const w = world.get();
    const f = fault("stuck-edits");
    const l = live();
    const vars = await plant(l, f);
    await plant(l, f);
    expect(await w.t.sql`SELECT 1 FROM outbox WHERE payload = '{"Mode": "delta"}'::jsonb`).toHaveLength(1);
    expect((await probes(l, f, vars))[0]).toEqual({
      ok: false,
      detail: expect.stringContaining("Kestrel's sync requests are still waiting"),
    });

    // The relay, once fixed, gives up on the poison and delivers what waited behind it.
    await w.t.sql`UPDATE outbox SET failed_at = now() WHERE payload = '{"Mode": "delta"}'::jsonb`;
    expect(await probes(l, f, vars)).toEqual([{ ok: true, detail: "" }]);

    await undo(l, f, vars);
    await undo(l, f, vars);
    expect(await w.t.sql`SELECT 1 FROM outbox WHERE payload = '{"Mode": "delta"}'::jsonb`).toHaveLength(0);
  });

  it("digest: plants a paused automation and last night's early fire, checks the scheduler's maths, undoes it", async () => {
    const w = world.get();
    const f = fault("digest");
    const l = live();
    const vars = await plant(l, f);
    await plant(l, f);
    const slot = localInstant(NOW, "02:30", -1).toISOString();
    expect(vars["local 02:30 -1"]).toBe(slot);
    const [automation] = await w.t.sql<{ enabled: boolean; cron: string; owner: string; fired: string }[]>`
      SELECT enabled, cron, owner_id AS owner, to_char(last_fired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS fired FROM automations WHERE name = 'Overnight payments digest'`;
    expect(automation).toEqual({
      enabled: false,
      cron: "30 2 * * *",
      owner: w.user("tom.whitfield"),
      fired: slot,
    });
    const fires = await w.t.sql<{ key: string }[]>`SELECT fire_key AS key FROM automation_fires`;
    expect(fires.map((row) => row.key)).toEqual([`schedule:${slot}`]);
    expect(fill(f.symptom, vars, "text")).toContain(`Last night it ran at ${slot.slice(11, 16)} UTC, not at 02:30 UTC`);

    // The code on disk is the reference: UTC. A scheduler on local hours fails.
    expect(await probes(l, f, vars)).toEqual([{ ok: true, detail: "" }]);
    const early = live({
      nextAfter: async () => (_cron, after) =>
        new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate() + 1, 0, 30)),
    });
    expect((await probes(early, f, vars))[0]).toEqual({
      ok: false,
      detail: expect.stringContaining(
        "The scheduler still doesn't fire `30 2 * * *` at 02:30 UTC once a day: it fires at 00:30 UTC",
      ),
    });

    await undo(l, f, vars);
    await undo(l, f, vars);
    expect(await w.t.sql`SELECT 1 FROM automations WHERE name = 'Overnight payments digest'`).toHaveLength(0);
    expect(await w.t.sql`SELECT 1 FROM automation_fires`).toHaveLength(0);
  });
});
