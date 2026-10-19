/**
 * The orchestration lab's server side (section 16): a run tree. Either the recorded hotel comparison, replayed in
 * memory through `#learn/agent/orchestrate` at a token cap the page picks, or one of the viewer's own runs that
 * delegated, read from Postgres. Each node shows its caps and what it spent (`#learn/agent/caps`' `runUsage`), and
 * the parent shows what it has left. Only the viewer's own runs, through RLS and a user check. Server only.
 */
import { sql } from "drizzle-orm";

import type { RunEvent, RunEventData, RunStatus } from "#learn/agent/types";
import type { Viewer } from "#learn/retrieve/types";
import type { Db } from "@/db/create";

import { type Caps, DEFAULT_CAPS, runUsage } from "#learn/agent/caps";
import { inMemoryRun } from "#learn/agent/loop-testing";
import { childOutcome } from "#learn/agent/orchestrate";
import { AGENT_INSTRUCTIONS } from "#learn/agent/prompt";
import {
  RECORDED_PARENT_CLOCK,
  recordedChildClock,
  replayTreeGuard,
  replayTreeModels,
  replayTreeTools,
  treeRecording,
} from "@/core/agent/orchestrate-recorded";
import { driveTree } from "@/core/agent/orchestrate-testing";
import { withTenantOn } from "@/db/tenant";

export const RECORDED_TREE = "recorded";

export interface TreeNode {
  runId: string;
  /** The parent's message, or the child's task. */
  text: string;
  status: RunStatus;
  reason: string | null;
  caps: Caps;
  used: { modelTurns: number; tokens: number; toolCalls: number };
  /** The run's last answer. */
  summary: string;
}

export interface RunTree {
  parent: TreeNode & {
    /** What its children spent, from their own logs. */
    children: Spend;
    /** What the parent counted of it: the `usage` on its delegate results, which its `used` includes. A run from
     * before children's spend was counted (M2's review) has none. */
    counted: Spend;
    left: Spend;
  };
  children: TreeNode[];
}

export interface Spend {
  tokens: number;
  toolCalls: number;
}

export type TreeResult = { tree: RunTree } | { error: string };

export interface TreeRun {
  id: string;
  status: RunStatus;
  text: string;
  children: number;
  createdAt: string;
}

const firstMessage = (events: readonly RunEvent[]) =>
  events.find(
    (e): e is RunEvent & { data: Extract<RunEventData, { type: "user_message" }> } => e.data.type === "user_message",
  )?.data.text ?? "";

/** The task a sub-agent was given, without the framing its first message wraps it in. */
const taskOf = (text: string) => text.replace(/^[\s\S]*?\n\nTask: /, "");

function node(runId: string, text: string, caps: Caps, events: readonly RunEvent[]): TreeNode {
  const outcome = childOutcome(events);
  const { modelTurns, tokens, toolCalls } = runUsage(events);
  return {
    runId,
    text,
    status: outcome.status,
    reason: outcome.reason ?? null,
    caps,
    used: { modelTurns, tokens, toolCalls },
    summary: outcome.summary,
  };
}

function tree(parent: TreeNode, parentEvents: readonly RunEvent[], children: TreeNode[]): RunTree {
  const spent = children.reduce(
    (sum, c) => ({ tokens: sum.tokens + c.used.tokens, toolCalls: sum.toolCalls + c.used.toolCalls }),
    { tokens: 0, toolCalls: 0 },
  );
  const counted = parentEvents.reduce(
    (sum, { data }) =>
      data.type === "tool_result" && data.usage
        ? { tokens: sum.tokens + data.usage.tokens, toolCalls: sum.toolCalls + data.usage.toolCalls }
        : sum,
    { tokens: 0, toolCalls: 0 },
  );
  return {
    parent: {
      ...parent,
      children: spent,
      counted,
      left: {
        tokens: Math.max(0, parent.caps.tokens - parent.used.tokens),
        toolCalls: Math.max(0, parent.caps.toolCalls - parent.used.toolCalls),
      },
    },
    children,
  };
}

const failed = (error: unknown): TreeResult => ({ error: error instanceof Error ? error.message : String(error) });

/**
 * Grace's recorded hotel comparison, replayed through the learner's `childStart`, `childCaps` and `delegateResult`
 * with the parent's token cap set to `tokens`. Nothing calls a model or the database.
 */
export async function replayRecordedTree(tokens: number): Promise<TreeResult> {
  try {
    const recording = treeRecording();
    const caps = { ...DEFAULT_CAPS, tokens };
    const run = inMemoryRun(recording.runId, RECORDED_PARENT_CLOCK);
    run.append(recording.events[0].data);
    const { children } = await driveTree(run, {
      modelFor: replayTreeModels().modelFor,
      tools: replayTreeTools(),
      viewer: recording.viewer,
      caps,
      instructions: AGENT_INSTRUCTIONS,
      reasoningEffort: "medium",
      guard: replayTreeGuard,
      childClock: recordedChildClock,
    });
    const order = new Map(
      run.events
        .flatMap((e) => (e.data.type === "assistant_turn" ? e.data.toolCalls : []))
        .map((c, i) => [c.callId, i]),
    );
    const sorted = [...children].sort((a, b) => (order.get(a.callId) ?? 0) - (order.get(b.callId) ?? 0));
    return {
      tree: tree(
        node(run.runId, recording.message, caps, run.events),
        run.events,
        sorted.map((c) => node(c.runId, c.task, c.caps, c.events)),
      ),
    };
  } catch (error) {
    return failed(error);
  }
}

/** The viewer's 20 newest runs that started sub-agents. */
export async function listTreeRuns(db: Db, viewer: Viewer): Promise<TreeRun[]> {
  const rows = await withTenantOn(db, viewer.tenantId, (tx) =>
    tx.execute<{ id: string; status: RunStatus; text: string | null; children: number; created_at: Date | string }>(sql`
      SELECT r.id, r.status, e.data ->> 'text' AS text, c.children::int AS children, r.created_at
      FROM runs r
      JOIN (SELECT parent_run_id, count(*) AS children FROM runs WHERE parent_run_id IS NOT NULL GROUP BY 1) c
        ON c.parent_run_id = r.id
      LEFT JOIN run_events e ON e.run_id = r.id AND e.seq = 1
      WHERE r.user_id = ${viewer.userId}
      ORDER BY r.created_at DESC
      LIMIT 20`),
  );
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    text: (row.text ?? "").replace(/\s+/g, " ").slice(0, 80),
    children: Number(row.children),
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

/** One of the viewer's runs and its children, from Postgres. */
export async function runTree(db: Db, viewer: Viewer, runId: string): Promise<TreeResult | null> {
  const rows = await withTenantOn(db, viewer.tenantId, (tx) =>
    tx.execute<{ id: string; parent_run_id: string | null; caps: Partial<Caps>; events: RunEvent[] | null }>(sql`
      SELECT r.id, r.parent_run_id, r.caps,
        (SELECT json_agg(json_build_object('runId', e.run_id, 'seq', e.seq, 'at', e.at, 'data', e.data) ORDER BY e.seq)
         FROM run_events e WHERE e.run_id = r.id) AS events
      FROM runs r
      WHERE r.user_id = ${viewer.userId} AND (r.id = ${runId} OR r.parent_run_id = ${runId})
      ORDER BY r.created_at, r.id`),
  );
  const parent = rows.find((r) => r.id === runId);
  if (!parent) return null;
  try {
    const events = (row: (typeof rows)[number]) =>
      (row.events ?? []).map((e) => ({ ...e, at: new Date(e.at).toISOString() }));
    const capsOf = (row: (typeof rows)[number]) => ({ ...DEFAULT_CAPS, ...row.caps });
    const parentEvents = events(parent);
    return {
      tree: tree(
        node(parent.id, firstMessage(parentEvents), capsOf(parent), parentEvents),
        parentEvents,
        rows
          .filter((r) => r.parent_run_id === runId)
          .map((r) => {
            const childEvents = events(r);
            return node(r.id, taskOf(firstMessage(childEvents)), capsOf(r), childEvents);
          }),
      ),
    };
  } catch (error) {
    return failed(error);
  }
}
