import type postgres from "postgres";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { RunEvent, RunStatus } from "#learn/agent/types";
import type { Viewer } from "#learn/retrieve/types";

/**
 * Section 14's recordings (`fixtures/cassettes/agent/runs/`): four real runs' `runs` row and `run_events`, exported
 * from the dev database on 19 October 2026 exactly as the app wrote them (no model was called to make them).
 *
 * - `kpc-email`: leo.martin asks the agent to email Tom Whitfield a two-line summary of KPC-2026-0142's payment
 *   terms (18 October, section 12's recording). 17 events in 15 appends; it waits for approval at seq 12.
 * - `cancel-waiting`: tom.whitfield's smoke run cancelled while it waited on its approval (14 October).
 * - `lost-plan`: tom.whitfield's smoke run that compacted before compaction kept the plan (14 October). Its summary
 *   (seq 17) had no plan, the model planned again (18), the policy refused it (19), and no mail went.
 * - `two-compactions`: daniel.reyes's long run that compacted twice (seq 16 and 23), each summary carrying the plan
 *   made at seq 3.
 *
 * Helpers here use plain SQL and never a `#learn` function, so a step's setup can't run the learner's code.
 */

export const RECORDED_RUNS = ["kpc-email", "cancel-waiting", "lost-plan", "two-compactions"] as const;
export type RecordedRunName = (typeof RECORDED_RUNS)[number];

export interface RecordedEvent extends RunEvent {
  /** The Workflow step that wrote it, or null outside Workflow. */
  stepKey: string | null;
}

export interface RecordedRun {
  run: {
    id: string;
    user: string;
    userId: string;
    kind: "chat";
    status: RunStatus;
    version: number;
    createdAt: string;
  };
  events: RecordedEvent[];
}

const DIR = join(import.meta.dirname, "../../../fixtures/cassettes/agent/runs");
const cache = new Map<RecordedRunName, RecordedRun>();

export function recordedRun(name: RecordedRunName): RecordedRun {
  let run = cache.get(name);
  if (!run) {
    run = JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")) as RecordedRun;
    cache.set(name, run);
  }
  return structuredClone(run);
}

/** A recorded run's events up to `throughSeq`, as the app reads them (`RunEvent`, no step key). */
export function recordedEvents(name: RecordedRunName, throughSeq = Infinity): RunEvent[] {
  return recordedRun(name)
    .events.filter((event) => event.seq <= throughSeq)
    .map(({ runId, seq, at, data }) => ({ runId, seq, at, data }));
}

/** Events split into the appends that wrote them. One append is one statement, so its events share their `at`
 * (Postgres's `now()` is the transaction's start). The count of appends is the run's version. */
export function appendsOf<E extends { at: string }>(events: readonly E[]): E[][] {
  const groups: E[][] = [];
  for (const event of events) {
    const last = groups.at(-1);
    if (last && last[0].at === event.at) last.push(event);
    else groups.push([event]);
  }
  return groups;
}

/** Where a log's status events leave the run (every run starts `queued`). No state machine: the log is trusted. */
export function lastStatus(events: readonly RunEvent[]): RunStatus {
  let status: RunStatus = "queued";
  for (const { data } of events) if (data.type === "status") status = data.to;
  return status;
}

const FINAL = new Set<RunStatus>(["succeeded", "failed", "cancelled", "timed_out"]);

export interface StateWorld {
  tenantId: string;
  /** The recorded run's user, in this world's tenant. */
  viewerOf(name: RecordedRunName): Viewer;
}

/** Kestrel Pay and the recorded runs' users (leo.martin, tom.whitfield, daniel.reyes), as directory principals. */
export async function stateWorld(sql: postgres.Sql): Promise<StateWorld> {
  const [{ id: tenantId }] = await sql<{ id: string }[]>`
    INSERT INTO organization (name, slug, created_at) VALUES ('Kestrel Pay', 'kestrel', now()) RETURNING id`;
  const users = new Map(RECORDED_RUNS.map((name) => [recordedRun(name).run.userId, recordedRun(name).run.user]));
  for (const [id, name] of users) {
    await sql`INSERT INTO principals (id, tenant_id, kind, external_id, name, display_name, enabled, synced_at)
              VALUES (${id}, ${tenantId}, 'user', ${id}, ${name}, ${name}, true, now())`;
  }
  return { tenantId, viewerOf: (name) => ({ tenantId, userId: recordedRun(name).run.userId }) };
}

export interface LoadedRun {
  runId: string;
  viewer: Viewer;
  /** How many appends wrote the loaded events. */
  version: number;
  status: RunStatus;
  events: RunEvent[];
}

/**
 * Writes a recorded run into the world's tenant as it stood after `throughSeq` (all of it by default): its `runs`
 * row at the version and status those events give, and the events with their seq, time, data and step key. A run
 * already there under the same id is replaced. With `eventsToo: false` only the row goes in, as a new `queued` run
 * at version 0, for a test that appends the events itself.
 */
export async function loadRecorded(
  sql: postgres.Sql,
  world: StateWorld,
  name: RecordedRunName,
  { throughSeq = Infinity, runId, eventsToo = true }: { throughSeq?: number; runId?: string; eventsToo?: boolean } = {},
): Promise<LoadedRun> {
  const recorded = recordedRun(name);
  const id = runId ?? recorded.run.id;
  const events = eventsToo ? recorded.events.filter((event) => event.seq <= throughSeq) : [];
  const status = lastStatus(events);
  const version = appendsOf(events).length;
  const viewer = world.viewerOf(name);
  await sql`DELETE FROM runs WHERE id = ${id}`;
  await sql`
    INSERT INTO runs (id, tenant_id, user_id, kind, status, version, created_at, finished_at)
    VALUES (${id}, ${world.tenantId}, ${viewer.userId}, ${recorded.run.kind}, ${status}, ${version},
      ${recorded.run.createdAt}, ${FINAL.has(status) ? (events.at(-1)?.at ?? null) : null})`;
  for (const event of events) {
    await sql`
      INSERT INTO run_events (tenant_id, run_id, seq, at, type, data, step_key)
      VALUES (${world.tenantId}, ${id}, ${event.seq}, ${event.at}, ${event.data.type},
        ${JSON.stringify(event.data)}::jsonb, ${event.stepKey})`;
  }
  return {
    runId: id,
    viewer,
    version,
    status,
    events: events.map(({ seq, at, data }) => ({ runId: id, seq, at, data })),
  };
}
