/**
 * The state lab's server side (section 14): the viewer's runs, one run's log with each event's seq and version,
 * and a lab run to race messages into. Only the viewer's own runs, through RLS and a user check.
 *
 * A lab run is a `chat` run with no conversation whose first message id starts with `lab-`. It has no runner, so
 * nothing calls a model: it stays `queued` until the lab cancels it. Messages go in through
 * `#learn/agent/messages` and the cancel through `cancelRun` (which appends through `#learn/agent/events` and
 * `#learn/agent/state`), so the lab shows the learner's code while a step of section 14 is active.
 * Server only: the route's server functions import it.
 */
import { sql } from "drizzle-orm";

import type { MessageResult } from "#learn/agent/messages";
import type { RunEventData, RunStatus } from "#learn/agent/types";
import type { Viewer } from "#learn/retrieve/types";
import type { Db } from "@/db/create";

import { addMessage } from "#learn/agent/messages";
import { withTenantOn } from "@/db/tenant";
import { cancelRun, startRun } from "@/lib/agent-runs";

export const LAB_MESSAGE_PREFIX = "lab-";

export interface LabRun {
  id: string;
  status: RunStatus;
  version: number;
  kind: string;
  /** The first message's text, cut short. */
  title: string;
  lab: boolean;
  createdAt: string;
}

export interface LogEvent {
  seq: number;
  /** The run's version after the append that wrote this event: events written together share their `at`. */
  version: number;
  at: string;
  type: RunEventData["type"];
  /** The event's data as JSON text, as Postgres keeps it. */
  data: string;
}

export interface RunLog {
  run: { id: string; status: RunStatus; version: number; lab: boolean } | null;
  events: LogEvent[];
}

/** The viewer's 20 newest runs. */
export async function listLabRuns(db: Db, viewer: Viewer): Promise<LabRun[]> {
  const rows = await withTenantOn(db, viewer.tenantId, (tx) =>
    tx.execute<{
      id: string;
      status: RunStatus;
      version: number;
      kind: string;
      conversation_id: string | null;
      message_id: string | null;
      text: string | null;
      created_at: Date | string;
    }>(sql`
      SELECT r.id, r.status, r.version, r.kind, r.conversation_id, e.data ->> 'messageId' AS message_id,
        e.data ->> 'text' AS text, r.created_at
      FROM runs r LEFT JOIN run_events e ON e.run_id = r.id AND e.seq = 1
      WHERE r.user_id = ${viewer.userId}
      ORDER BY r.created_at DESC
      LIMIT 20`),
  );
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    version: Number(row.version),
    kind: row.kind,
    title: (row.text ?? "").replace(/\s+/g, " ").slice(0, 80),
    lab: isLab(row),
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

const isLab = (row: { kind: string; conversation_id: string | null; message_id: string | null }) =>
  row.kind === "chat" && row.conversation_id === null && (row.message_id ?? "").startsWith(LAB_MESSAGE_PREFIX);

/**
 * One run's events after `after`, read in one statement so the run's version and its events come from the same
 * moment. Each event's version is the number of appends up to and including its own. The log doesn't store it,
 * but an append is one statement, so its events share their `at` (the transaction's start). Appends are numbered
 * by their first seq, not their time: a writer that lost a race started before the winner, so its `at` is earlier
 * though its seq is later.
 */
export async function runLog(db: Db, viewer: Viewer, runId: string, after = 0): Promise<RunLog> {
  const [row] = await withTenantOn(db, viewer.tenantId, (tx) =>
    tx.execute<{
      id: string;
      status: RunStatus;
      version: number;
      kind: string;
      conversation_id: string | null;
      message_id: string | null;
      events: LogEvent[] | null;
    }>(sql`
      SELECT r.id, r.status, r.version, r.kind, r.conversation_id,
        (SELECT data ->> 'messageId' FROM run_events WHERE run_id = r.id AND seq = 1) AS message_id,
        (SELECT json_agg(json_build_object('seq', e.seq, 'version', e.version, 'at', e.at, 'type', e.type,
            'data', e.data::text) ORDER BY e.seq)
         FROM (SELECT seq, at, type, data, dense_rank() OVER (ORDER BY first) AS version
               FROM (SELECT seq, at, type, data, min(seq) OVER (PARTITION BY at) AS first
                     FROM run_events WHERE run_id = r.id) g) e
         WHERE e.seq > ${after}::bigint) AS events
      FROM runs r
      WHERE r.id = ${runId} AND r.user_id = ${viewer.userId}`),
  );
  if (!row) return { run: null, events: [] };
  return {
    run: { id: row.id, status: row.status, version: Number(row.version), lab: isLab(row) },
    events: (row.events ?? []).map((e) => ({ ...e, at: new Date(e.at).toISOString() })),
  };
}

/** A new lab run: queued, with one message, and no runner. */
export async function startLabRun(db: Db, viewer: Viewer): Promise<{ runId: string }> {
  const runId = crypto.randomUUID();
  await startRun(db, viewer, {
    runId,
    message: {
      messageId: `${LAB_MESSAGE_PREFIX}${crypto.randomUUID()}`,
      text: "Lab run: send it two messages at once.",
    },
  });
  return { runId };
}

export interface SendResult {
  label: "first" | "second" | "resend of the first";
  messageId: string;
  text: string;
  result: MessageResult | { kind: "error"; message: string };
}

async function guardLab(db: Db, viewer: Viewer, runId: string): Promise<string | null> {
  const { run } = await runLog(db, viewer, runId, Number.MAX_SAFE_INTEGER);
  if (!run) return "no such run";
  if (!run.lab) return "only a lab run takes messages here: a real run's runner wouldn't be told about them";
  return null;
}

async function send(
  db: Db,
  viewer: Viewer,
  runId: string,
  label: SendResult["label"],
  message: { messageId: string; text: string },
): Promise<SendResult> {
  try {
    return { label, ...message, result: await addMessage(db, viewer, runId, message) };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return { label, ...message, result: { kind: "error", message: text } };
  }
}

/**
 * Two messages into a lab run at the same moment, then the first one again (a resend, same id). With section
 * 14's code, both land once each in seq order and the resend answers `duplicate`.
 */
export async function sendTwoAtOnce(
  db: Db,
  viewer: Viewer,
  runId: string,
): Promise<{ error: string } | { sent: SendResult[] }> {
  const refused = await guardLab(db, viewer, runId);
  if (refused) return { error: refused };
  const stamp = new Date().toISOString().slice(11, 19);
  const first = { messageId: `${LAB_MESSAGE_PREFIX}${crypto.randomUUID()}`, text: `First message (${stamp})` };
  const second = { messageId: `${LAB_MESSAGE_PREFIX}${crypto.randomUUID()}`, text: `Second message (${stamp})` };
  const sent = await Promise.all([send(db, viewer, runId, "first", first), send(db, viewer, runId, "second", second)]);
  sent.push(await send(db, viewer, runId, "resend of the first", first));
  return { sent };
}

/** Cancels a lab run, through the app's `cancelRun`. */
export async function cancelLabRun(
  db: Db,
  viewer: Viewer,
  runId: string,
): Promise<{ error?: string; result?: string }> {
  const refused = await guardLab(db, viewer, runId);
  if (refused) return { error: refused };
  try {
    return { result: await cancelRun(db, viewer, runId) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
