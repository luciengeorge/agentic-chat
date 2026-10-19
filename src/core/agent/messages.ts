import { sql } from "drizzle-orm";

import type { Appended } from "#learn/agent/events";
import type { RunEventData, RunStatus } from "#learn/agent/types";
import type { Viewer } from "#learn/retrieve/types";
import type { Db } from "@/db/create";

import { append, VersionConflictError } from "#learn/agent/events";
import { isFinal } from "#learn/agent/state";
import { type Tx, withTenantOn } from "@/db/tenant";

/** How many times a writer re-reads and tries again before it gives up. */
export const MAX_CONFLICT_RETRIES = 20;

export interface NewMessage {
  /** The client's id for the message: its idempotency key. */
  messageId: string;
  text: string;
}

export type MessageResult =
  | { kind: "not-found" }
  | { kind: "finished"; status: RunStatus }
  | { kind: "added" | "duplicate"; seq: number; status: RunStatus };

/** The Postgres error code on an error or its causes (`23505` is a unique violation). */
export function pgCode(error: unknown): string | undefined {
  for (let e = error; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/**
 * Appends what `build` makes of the run as it is now, re-reading and building again while other writers get in
 * first. For events that stay true whatever was appended meanwhile (a user message, a tool result, a decision).
 * `build` returns null to append nothing (say, the run has finished), and so does this.
 */
export async function appendRetrying(
  tx: Tx,
  runId: string,
  build: (state: { version: number; status: RunStatus }) => RunEventData[] | null,
  activeMs = 0,
): Promise<Appended | null> {
  for (let attempt = 0; ; attempt++) {
    const [run] = await tx.execute<{ status: RunStatus; version: number }>(
      sql`SELECT status, version FROM runs WHERE id = ${runId}`,
    );
    const events = build(run);
    if (!events) return null;
    try {
      return await append(tx, runId, run.version, events, { activeMs });
    } catch (error) {
      if (!(error instanceof VersionConflictError) || attempt >= MAX_CONFLICT_RETRIES) throw error;
    }
  }
}

/** The seq of the run's user message with this id, if it has one. */
export async function messageSeq(tx: Tx, runId: string, messageId: string): Promise<number | null> {
  const [row] = await tx.execute<{ seq: number }>(sql`
    SELECT seq FROM run_events
    WHERE run_id = ${runId} AND type = 'user_message' AND data ->> 'messageId' = ${messageId}`);
  return row ? Number(row.seq) : null;
}

/** The run's status, if the run is the viewer's. Another user's run and another tenant's (RLS) are null. */
export async function ownStatus(tx: Tx, viewer: Viewer, runId: string): Promise<RunStatus | null> {
  const [row] = await tx.execute<{ status: RunStatus; user_id: string }>(
    sql`SELECT status, user_id FROM runs WHERE id = ${runId}`,
  );
  return row && row.user_id === viewer.userId ? row.status : null;
}

/**
 * Adds a user message to a live run, once per `messageId`: a resend finds the first one and stores nothing.
 * Messages that arrive together all land, in `seq` order: a writer that loses the version race reads again and
 * appends after the winner. A message can't go into a finished run.
 */
export async function addMessage(db: Db, viewer: Viewer, runId: string, message: NewMessage): Promise<MessageResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withTenantOn(db, viewer.tenantId, async (tx) => {
        const status = await ownStatus(tx, viewer, runId);
        if (!status) return { kind: "not-found" } as const;
        const seen = await messageSeq(tx, runId, message.messageId);
        if (seen !== null) return { kind: "duplicate", seq: seen, status } as const;
        const appended = await appendRetrying(tx, runId, ({ status }) =>
          isFinal(status) ? null : [{ type: "user_message", messageId: message.messageId, text: message.text }],
        );
        if (!appended) return { kind: "finished", status: (await ownStatus(tx, viewer, runId))! } as const;
        return { kind: "added", seq: appended.events[0].seq, status: appended.status } as const;
      });
    } catch (error) {
      // The same message sent twice at once: the second insert hits the unique index. Try again to find the first.
      if (pgCode(error) !== "23505" || attempt >= 2) throw error;
    }
  }
}
