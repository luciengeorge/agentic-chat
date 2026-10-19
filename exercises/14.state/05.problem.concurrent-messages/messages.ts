// 👨‍💼 Leo's run waits on his approval. He clicks Approve in the inbox and, in the same second, sends two follow-ups
//    from the chat: "Copy Amara Okafor too." and "Mention the 30-day terms." His train then loses signal, and the
//    browser sends the first follow-up again. All three writes must land, in one order, each once, and the resend
//    must store nothing. The approval and the messages are the user's: none of them may be lost to a race.

import { sql } from "drizzle-orm";

import type { Appended } from "#learn/agent/events";
import type { RunEventData, RunStatus } from "#learn/agent/types";
import type { Viewer } from "#learn/retrieve/types";
import type { Db } from "@/db/create";
import type { Tx } from "@/db/tenant";

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
  // 🐨 Loop, at most MAX_CONFLICT_RETRIES + 1 times:
  //    - read the run's `status` and `version`, now (`tx.execute(sql\`SELECT status, version FROM runs ...\`)`);
  //    - call `build` with them. If it returns null, return null: there's nothing to write any more;
  //    - append what it built at the version you just read, and return what `append` returns;
  //    - if `append` threw a VersionConflictError, go round again: read again, build again. Throw anything else
  //      at once, and the conflict too once you're out of tries.
  //
  // 💰 Import `append` and `VersionConflictError` from "#learn/agent/events".
  // 💰 `for (let attempt = 0; ; attempt++) { ... }` and `error instanceof VersionConflictError`.
  //
  // 🦉 Why build again, not just retry. The events a writer appends depend on the run it read. A cancel appends
  //    `<the status now> -> cancelled`; an approval appends nothing once the run is final. If the version moved,
  //    the run may have moved too: a conflict means "what you decided may be wrong". So the retry reads again and
  //    asks `build` again. The classic mistake retries the same events with a newer version, or the same version
  //    twenty times: the first writes a stale `from` that the state machine refuses, the second never lands.
  // 🦉 Why this is safe for some events and not others. A user message, a decision or a tool result is true
  //    whatever got in first: Leo did send it. A model turn isn't: it was written without seeing the follow-up,
  //    so the runner throws it away on a conflict and asks the model again (`driveRun` in src/lib/agent-runs.ts).
  //    That's the line between `appendRetrying` and plain `append`.
  //
  // 🚨 The tests slip another writer in right after your first read, and race three writers on one run.
  throw new Error(`appendRetrying(${typeof tx}, run ${runId}, ${typeof build}, ${activeMs} ms) isn't written yet`);
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
  // 🐨 In one transaction in the viewer's tenant (`withTenantOn(db, viewer.tenantId, async (tx) => ...)`):
  //    - the run's status, if it's the viewer's (`ownStatus`). Null: `{ kind: "not-found" }`;
  //    - if the run already holds a message with this `messageId` (`messageSeq`): `{ kind: "duplicate", seq,
  //      status }`, and write nothing;
  //    - otherwise append `{ type: "user_message", messageId, text }` with `appendRetrying`, whose `build` returns
  //      null when the run's status is final. Null back: `{ kind: "finished", status: <its status now> }`. Else
  //      `{ kind: "added", seq: <the event's seq>, status: <appended.status> }`.
  // 🐨 Two sends of the same message at once both pass the `messageSeq` check before either commits; the second
  //    insert then hits the unique index on `(run_id, data->>'messageId')`, Postgres code 23505. Catch that
  //    (`pgCode(error) === "23505"`), and run the whole transaction again, up to 3 times in all: this time
  //    `messageSeq` finds the first one, and the answer is `duplicate`.
  //
  // 💰 Import `isFinal` from "#learn/agent/state" and `withTenantOn` from "@/db/tenant" (beside `type Tx`).
  //
  // 🦉 Why the client's id is the key. The browser makes the id once, when Leo presses send
  //    (`crypto.randomUUID()`), and sends it with every attempt. A lost response and a retry carry the same id, so
  //    the server can tell "again" from "another". The classic mistake makes the key on the server, or per
  //    attempt (`Date.now()`, a fresh uuid in the retry loop): then every resend is a new message, and the run
  //    reads "Copy Amara Okafor too." twice. Text isn't a key either: Leo may well say "Yes." twice.
  // 🦉 Why check first and keep the index. The check answers the common case (a resend seconds later) politely,
  //    with the first message's seq. The unique index is what makes "once" true when two sends overlap: only the
  //    database sees both at once. Catching its error and asking again turns the race into the polite answer.
  //
  // 📜 https://www.postgresql.org/docs/current/errcodes-appendix.html (23505 unique_violation)
  //
  // 🚨 The tests resend a message, send the same one twice at once, send three things at once, and write into a
  //    finished run, another user's and none at all.
  throw new Error(
    `addMessage(${typeof db}, ${viewer.userId}, run ${runId}, message ${message.messageId}) isn't written yet`,
  );
}
