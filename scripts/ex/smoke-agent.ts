import { randomUUID } from "node:crypto";

import type { RunEvent, RunStatus, ToolCall } from "#learn/agent/types";

import { loadWorld } from "@/fixtures/world";

import { CONTROL_HEADER, DEV_CONTROL_TOKEN } from "../../servers/fake-workspace/control";
import { readText, send, sessionCookie, signIn, type SmokeTargets } from "./smoke";

const FINAL: readonly RunStatus[] = ["succeeded", "failed", "cancelled", "timed_out"];
const RUN_TIMEOUT_MS = 240_000;
/** A 429 on the run bucket (5 in a burst, then one every 30 s) is waited out up to this long. */
const RATE_LIMIT_WAIT_MS = 65_000;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A signed-in user of the seeded world, talking to the app's agent routes. */
export class AgentClient {
  private constructor(
    private readonly target: SmokeTargets,
    readonly cookie: string,
  ) {}

  static async signIn(target: SmokeTargets, tenant: string, username: string): Promise<AgentClient> {
    const world = loadWorld();
    const response = await signIn(target, world.user(tenant, username).email, world.tenant(tenant).password);
    await readText(response, `${username}'s sign-in`);
    return new AgentClient(target, sessionCookie(response));
  }

  /** GET without a body, POST with one; DELETE when asked. */
  request(path: string, body?: unknown, signal?: AbortSignal, method?: string): Promise<Response> {
    return send(this.target.fetch, { url: this.target.appUrl, start: "pnpm dev" }, path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "content-type": "application/json", origin: this.target.appUrl, cookie: this.cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  }

  async get(path: string): Promise<Record<string, unknown>> {
    return JSON.parse(await readText(await this.request(path), `GET ${path}`)) as Record<string, unknown>;
  }

  async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    return JSON.parse(await readText(await this.request(path, body), `POST ${path}`)) as Record<string, unknown>;
  }

  /** `POST /api/runs` with a fresh run id, waiting out the run bucket's 429s. */
  async startRun(text: string): Promise<string> {
    const id = randomUUID();
    const deadline = Date.now() + RATE_LIMIT_WAIT_MS;
    for (;;) {
      const response = await this.request("/api/runs", { id, message: { id: `smoke-${id.slice(0, 8)}`, text } });
      if (response.status === 429 && Date.now() < deadline) {
        await sleep(Number(response.headers.get("retry-after") ?? 5) * 1000);
        continue;
      }
      await readText(response, "POST /api/runs");
      return id;
    }
  }

  /** Follows a run's event stream (`GET /api/runs/:id/stream`), from its first event to its final status. */
  follow(runId: string, timeoutMs = RUN_TIMEOUT_MS): RunFollower {
    return new RunFollower(runId, (signal) => this.request(`/api/runs/${runId}/stream`, undefined, signal), timeoutMs);
  }

  async signOut(): Promise<void> {
    await this.request("/api/auth/sign-out", {}).catch(() => {});
  }
}

/** Reads a run's SSE stream as it arrives; `until` waits for an event, `done` for the stream's end. */
export class RunFollower {
  readonly events: RunEvent[] = [];
  readonly done: Promise<void>;
  private readonly abort = new AbortController();
  private waiting: (() => void)[] = [];

  constructor(
    readonly runId: string,
    open: (signal: AbortSignal) => Promise<Response>,
    timeoutMs: number,
  ) {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(timeoutMs)]);
    this.done = this.read(open, signal).finally(() => this.wake());
    this.done.catch(() => {}); // awaited by whoever needs it
  }

  private async read(open: (signal: AbortSignal) => Promise<Response>, signal: AbortSignal): Promise<void> {
    const response = await open(signal);
    if (!response.ok || !response.body) await readText(response, `run ${this.runId}'s stream`);
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body!) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const lines = block.split("\n");
        // Token lines (`event: token`) and heartbeats (comments) carry no event.
        if (lines.some((line) => line.startsWith("event:"))) continue;
        const data = lines.find((line) => line.startsWith("data: "));
        if (data) this.events.push(JSON.parse(data.slice("data: ".length)) as RunEvent);
      }
      this.wake();
    }
  }

  private wake(): void {
    for (const resolve of this.waiting.splice(0)) resolve();
  }

  get status(): RunStatus | null {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const data = this.events[i].data;
      if (data.type === "status") return data.to;
    }
    return null;
  }

  /** The first event after `from` (an index into `events`) that `match` picks; fails if the run ends first. */
  async until<T>(what: string, match: (event: RunEvent) => T | null | undefined, from = 0): Promise<T> {
    for (let seen = from; ;) {
      for (; seen < this.events.length; seen++) {
        const found = match(this.events[seen]);
        if (found) return found;
      }
      const ended = await Promise.race([
        this.done.then(
          () => "ended",
          (error: Error) => error.message,
        ),
        new Promise<null>((resolve) => this.waiting.push(() => resolve(null))),
      ]);
      if (ended !== null && seen >= this.events.length) {
        throw new Error(
          `run ${this.runId} ${this.status ?? "stream"} ${ended === "ended" ? "ended" : `failed (${ended})`} before ${what}: ${this.summary()}`,
        );
      }
    }
  }

  /** Waits for the stream to end, which it does once the run is final. */
  async final(): Promise<RunStatus> {
    await this.done;
    const status = this.status;
    if (!status || !FINAL.includes(status)) throw new Error(`run ${this.runId}'s stream ended at ${status}`);
    return status;
  }

  stop(): void {
    this.abort.abort();
  }

  /** The run's events in short: types, tool names and statuses. */
  summary(): string {
    return this.events
      .map(({ data }) => {
        if (data.type === "status")
          return `->${data.to}${data.to === "failed" && data.reason ? ` (${data.reason})` : ""}`;
        if (data.type === "assistant_turn")
          return data.toolCalls.length ? data.toolCalls.map((c) => c.tool).join("+") : "answer";
        if (data.type === "approval_requested") return `approval(${data.call.tool})`;
        if (data.type === "approval_decided") return data.decision;
        if (data.type === "tool_result") return data.ok ? "ok" : "refused";
        return data.type;
      })
      .join(", ");
  }

  tokens(): { input: number; output: number } {
    let input = 0;
    let output = 0;
    for (const { data } of this.events) {
      if (data.type !== "assistant_turn") continue;
      input += data.usage.inputTokens ?? 0;
      output += data.usage.outputTokens ?? 0;
    }
    return { input, output };
  }
}

type Approval = { approvalId: string; call: ToolCall };

export const approvalRequested = (event: RunEvent): Approval | null =>
  event.data.type === "approval_requested" ? { approvalId: event.data.approvalId, call: event.data.call } : null;

/** The mail fake-workspace holds for a run: its tools send `agent:<runId>:<step>` as the key. */
export async function mailsOf(target: SmokeTargets, runId: string) {
  const response = await send(
    target.fetch,
    { url: target.workspaceUrl, start: "pnpm fake-workspace" },
    "/_control/mail",
    {
      headers: { [CONTROL_HEADER]: target.workspaceControlToken ?? DEV_CONTROL_TOKEN },
    },
  );
  const { value } = JSON.parse(await readText(response, "GET /_control/mail")) as {
    value: { to: string[]; subject: string; idempotencyKey: string | null }[];
  };
  return value.filter((mail) => mail.idempotencyKey?.startsWith(`agent:${runId}:`));
}

/** The plan in the run's first model turn, which plan-then-execute requires. */
function plannedWrites(events: readonly RunEvent[]): string[] | null {
  const turn = events.find((e) => e.data.type === "assistant_turn");
  if (turn?.data.type !== "assistant_turn") return null;
  const plan = turn.data.toolCalls.find((c) => c.tool === "make_plan");
  if (!plan) return null;
  const writes = (plan.input as { writes?: { tool: string }[] }).writes ?? [];
  return writes.map((w) => w.tool);
}

const TOM = "tom.whitfield@kestrelpay.example";
export const AGENT_TASK =
  `Email Tom Whitfield (${TOM}) a short summary of the payment terms in contract KPC-2026-0142. ` +
  "Put the terms in the body; don't attach anything.";

/**
 * 10. Agent: as leo.martin, a run asked to mail Tom the payment terms of KPC-2026-0142 plans the mail, asks for
 * approval, is approved, ends `succeeded`, and fake-workspace holds exactly one mail with the run's key, to Tom.
 */
export async function checkAgent(target: SmokeTargets): Promise<string> {
  const leo = await AgentClient.signIn(target, "kestrel", "leo.martin");
  let run: RunFollower | null = null;
  try {
    const runId = await leo.startRun(AGENT_TASK);
    run = leo.follow(runId);
    const { approvalId, call } = await run.until("asking for approval", approvalRequested);
    const planned = plannedWrites(run.events);
    if (!planned?.includes("send_mail"))
      throw new Error(`run ${runId}'s first turn planned [${planned ?? "nothing"}], no send_mail`);
    if (call.tool !== "send_mail") throw new Error(`run ${runId} asked to approve ${call.tool}, not send_mail`);
    const asked = run.events.length;
    await leo.post(`/api/approvals/${approvalId}`, { decision: "approved" });
    // Resolves on a second approval; throws once the stream ends without one.
    const another = await run.until("ending", approvalRequested, asked).catch(() => null);
    if (another) throw new Error(`run ${runId} asked for a second write: ${run.summary()}`);
    const status = await run.final();
    if (status !== "succeeded") throw new Error(`run ${runId} ended ${status}: ${run.summary()}`);
    const mails = await mailsOf(target, runId);
    if (mails.length !== 1) throw new Error(`run ${runId} sent ${mails.length} mails with its key, want 1`);
    if (mails[0].to.join() !== TOM) throw new Error(`run ${runId} mailed ${mails[0].to.join(", ")}, not ${TOM}`);
    const { input, output } = run.tokens();
    return `run ${runId}: planned send_mail, approved, succeeded; 1 mail to Tom with key ${mails[0].idempotencyKey}; ${input} tokens in, ${output} out`;
  } finally {
    run?.stop();
    await leo.signOut();
  }
}

const NOTE_TASK = (marker: string) =>
  `Email Leo Martin (leo.martin@kestrelpay.example) one line saying "smoke ${marker}". Nothing else.`;

/** Rejects every approval the run asks for until it ends; returns how many it rejected. */
async function rejectUntilFinal(client: AgentClient, run: RunFollower): Promise<number> {
  let rejected = 0;
  let from = 0;
  for (;;) {
    const next = await run.until("its next approval", approvalRequested, from).catch(() => null);
    if (!next) return rejected;
    from = run.events.findIndex((e) => approvalRequested(e)?.approvalId === next.approvalId) + 1;
    await client.post(`/api/approvals/${next.approvalId}`, { decision: "rejected" });
    rejected += 1;
    if (rejected > 3) throw new Error(`run ${run.runId} kept asking after ${rejected} rejections`);
  }
}

/**
 * 11. Approval: as tom.whitfield, one run's mail is rejected and the run then ends `succeeded` without sending;
 * another is cancelled while it waits on its approval and ends `cancelled`, without sending. With
 * `mailbox: false` (a deploy, where no fake-workspace runs) it doesn't ask fake-workspace what was sent.
 */
export async function checkApproval(target: SmokeTargets, { mailbox = true } = {}): Promise<string> {
  const tom = await AgentClient.signIn(target, "kestrel", "tom.whitfield");
  const runs: RunFollower[] = [];
  try {
    const [rejectId, cancelId] = await Promise.all([
      tom.startRun(NOTE_TASK("reject")),
      tom.startRun(NOTE_TASK("cancel")),
    ]);
    const rejectRun = tom.follow(rejectId);
    const cancelRun = tom.follow(cancelId);
    runs.push(rejectRun, cancelRun);

    const rejecting = (async () => {
      await rejectRun.until("asking for approval", approvalRequested);
      const rejected = await rejectUntilFinal(tom, rejectRun);
      const status = await rejectRun.final();
      if (status !== "succeeded")
        throw new Error(`the rejected run ${rejectId} ended ${status}: ${rejectRun.summary()}`);
      return rejected;
    })();
    const cancelling = (async () => {
      await cancelRun.until("asking for approval", approvalRequested);
      await tom.post(`/api/runs/${cancelId}/cancel`, {});
      const status = await cancelRun.final();
      if (status !== "cancelled")
        throw new Error(`the cancelled run ${cancelId} ended ${status}: ${cancelRun.summary()}`);
    })();
    const [rejected] = await Promise.all([rejecting, cancelling]);

    for (const id of mailbox ? [rejectId, cancelId] : []) {
      const mails = await mailsOf(target, id);
      if (mails.length) throw new Error(`run ${id} sent ${mails.length} mail(s) with its key`);
    }
    const decided = rejectRun.events.filter((e) => e.data.type === "approval_decided").length;
    const mail = mailbox ? ", no mail" : "";
    return `run ${rejectId}: ${rejected} rejection(s) (${decided} decided), succeeded${mail}; run ${cancelId}: cancelled while waiting${mail}`;
  } finally {
    for (const run of runs) run.stop();
    await tom.signOut();
  }
}
