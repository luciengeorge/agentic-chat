/**
 * Section 15's test world: Grace Adeyemi's recorded run (`kpc-terms`, recorded once for section 13) driven by the
 * app's own runners, the job queue and Workflow, with nothing called live. Her model replies replay from the
 * recording, her tools answer as they did, and `send_mail` goes to a `Mailroom` that keeps one mail per
 * idempotency key, as fake-workspace does.
 */
import type postgres from "postgres";
import type { Hook } from "workflow";

import type { Plan } from "#learn/agent/checkpoint";
import type { RunContext } from "#learn/agent/durable-replay";
import type { Durable, RunSignal, RunSteps } from "#learn/agent/durable-run";
import type { RunGuard } from "#learn/agent/loop";
import type { AgentTool, RunEventData, ToolCall } from "#learn/agent/types";
import type { ChatModel } from "#learn/model/types";
import type { Viewer } from "#learn/retrieve/types";
import type { Db } from "@/db/create";
import type { AgentRuntime } from "@/lib/agent-runtime";

import { RunSignals } from "#learn/agent/durable-run";
import { recordedRun, replayAgentModel, replayGuard, replayTools } from "@/core/agent/loop-recorded";
import { createRunnerLoop } from "@/lib/agent-runs";

import type { Runtime } from "../../../servers/fake-workspace/app";

import { createApp } from "../../../servers/fake-workspace/app";
import { CONTROL_HEADER, DEV_CONTROL_TOKEN } from "../../../servers/fake-workspace/control";
import { FAST, ManualClock } from "../../../servers/fake-workspace/testing";

export const GRACE_RUN = recordedRun("kpc-terms");
/** "Email Tom Whitfield a two-line summary of the payment terms in contract KPC-2026-0142." */
export const GRACE_MESSAGE = GRACE_RUN.message;

/** A tenant with Grace in it, at her dev database id. */
export async function durableWorld(sql: postgres.Sql): Promise<{ tenantId: string; grace: Viewer }> {
  const [{ id: tenantId }] = await sql<{ id: string }[]>`
    INSERT INTO organization (name, slug, created_at) VALUES ('Kestrel Pay', 'kestrel', now()) RETURNING id`;
  const userId = GRACE_RUN.viewer.userId;
  await sql`INSERT INTO principals (id, tenant_id, kind, external_id, name, display_name, enabled, synced_at)
            VALUES (${userId}, ${tenantId}, 'user', ${userId}, 'grace.adeyemi', 'Grace Adeyemi', true, now())`;
  return { tenantId, grace: { tenantId, userId } };
}

/**
 * fake-workspace's mailroom, as far as keys go: every send attempt is counted, and the same key twice is one mail.
 */
export class Mailroom {
  readonly attempts: string[] = [];

  send(key: string): void {
    this.attempts.push(key);
  }

  /** The mails delivered: one per key. */
  get mails(): string[] {
    return [...new Set(this.attempts)];
  }
}

export interface GraceToolsOptions {
  /** Hold this many sends in flight until their signal aborts, as a server killed mid-send leaves them. */
  hangSends?: number;
}

/** Grace's six tools as recorded, with `send_mail` posting to `mailroom` under the key it's handed. */
export function graceTools(mailroom: Mailroom, { hangSends = 0 }: GraceToolsOptions = {}): AgentTool[] {
  let hung = 0;
  return replayTools("kpc-terms").map((tool) =>
    tool.name !== "send_mail"
      ? tool
      : {
          ...tool,
          async execute(input, ctx) {
            if (hung < hangSends) {
              hung++;
              // The request went out; the answer never came back.
              mailroom.send(ctx.idempotencyKey);
              await new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason)));
            }
            mailroom.send(ctx.idempotencyKey);
            return tool.execute(input, ctx);
          },
        },
  );
}

export interface GraceRuntimeOptions extends GraceToolsOptions {
  mailroom: Mailroom;
  /** Her recorded model by default. */
  model?: ChatModel;
  /** Her recorded screens, spending nothing, by default. */
  guard?: RunGuard;
  approvalTtlMs?: number;
  stepTimeoutMs?: number;
}

/** The app's runtime for Grace's run: the recorded model and tools, her recorded screens, no compaction. */
export function graceRuntime(db: Db, options: GraceRuntimeOptions): AgentRuntime {
  // One model for every step: the replay answers the nth call with the nth recorded turn.
  const model = options.model ?? replayAgentModel("kpc-terms").model;
  const tools = graceTools(options.mailroom, options);
  return {
    db,
    retryAfterMs: 1,
    approvalTtlMs: options.approvalTtlMs,
    stepTimeoutMs: options.stepTimeoutMs,
    loop: (viewer) => ({
      ...createRunnerLoop(viewer, {
        model,
        tools,
        reasoningEffort: "medium",
        guard: options.guard ?? replayGuard("kpc-terms"),
      }),
      compact: async () => null,
    }),
  };
}

/**
 * Grace's recorded model, except that its call number `turn` (from 0) hangs until it's aborted, as a model call
 * in flight does when the server dies or the user cancels. `calls` counts the calls made.
 */
export function hangingModel(turn: number): { model: ChatModel; calls: () => number; aborted: () => boolean } {
  const replay = replayAgentModel("kpc-terms");
  let calls = 0;
  let aborted = false;
  return {
    calls: () => calls,
    aborted: () => aborted,
    model: {
      id: "hanging",
      async *stream(request) {
        if (calls++ === turn) {
          const signal = request.abortSignal!;
          await new Promise((_, reject) =>
            signal.addEventListener("abort", () => {
              aborted = true;
              reject(signal.reason);
            }),
          );
        }
        yield* replay.model.stream(request);
      },
    },
  };
}

/** A model whose every call fails with this HTTP status, as the AI SDK reports one. */
export function failingModel(statusCode: number): ChatModel {
  return {
    id: `failing-${statusCode}`,
    // oxlint-disable-next-line require-yield
    async *stream() {
      throw Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });
    },
  };
}

export const WORKSPACE_URL = "http://fw";
export const KESTREL_WORKSPACE_TOKEN = "dev-workspace-kestrel";

export interface HeldWorkspace {
  runtime: Runtime;
  /** Graph requests as a network client makes them: an abort gives up on the answer, while the server carries on
   * with the request, as it does when the caller's process dies. */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** Each request the server finished: its Idempotency-Key, status and whether it was a replay. */
  answers: Array<{ key: string | null; status: number; replayed: boolean }>;
  /** A control API call (`/_control<path>`); throws unless it succeeds. */
  control(method: string, path: string, json?: unknown): Promise<Response>;
  /** The seconds each wait inside the server was for, held or not: a latency fault adds one. */
  waits(): readonly number[];
  /** Lets every request held by a latency fault go, and waits for the server to finish them. */
  release(): Promise<void>;
  close(): Promise<void>;
}

/**
 * fake-workspace in process, over the committed corpus, with a clock that holds every wait: a latency fault keeps
 * its request in the server until `release()`.
 */
export function heldWorkspace(): HeldWorkspace {
  const clock = new ManualClock({ gated: true });
  const { app, runtime } = createApp({ env: "dev", clock, policy: FAST });
  const inFlight: Promise<unknown>[] = [];
  const answers: HeldWorkspace["answers"] = [];
  return {
    runtime,
    answers,
    fetch(url, init = {}) {
      const { signal, ...rest } = init;
      const request = new Request(new URL(url, WORKSPACE_URL), rest);
      const key = request.headers.get("idempotency-key");
      const served = Promise.resolve(app.fetch(request)).then((response) => {
        answers.push({
          key,
          status: response.status,
          replayed: response.headers.get("idempotent-replayed") === "true",
        });
        return response;
      });
      inFlight.push(served.catch(() => {}));
      if (!signal) return served;
      return Promise.race([
        served,
        new Promise<never>((_, reject) => {
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      ]);
    },
    async control(method, path, json) {
      const response = await app.fetch(
        new Request(`${WORKSPACE_URL}/_control${path}`, {
          method,
          headers: { [CONTROL_HEADER]: DEV_CONTROL_TOKEN, "content-type": "application/json" },
          ...(json === undefined ? {} : { body: JSON.stringify(json) }),
        }),
      );
      if (!response.ok) throw new Error(`${method} /_control${path}: ${response.status} ${await response.text()}`);
      return response;
    },
    waits: () => clock.waits,
    async release() {
      clock.open();
      await Promise.all(inFlight);
    },
    close: () => runtime.notifier.close(),
  };
}

type ToolResult = Extract<RunEventData, { type: "tool_result" }>;

/** A tool call's result, as a fake step returns it. */
export const resultOf = (call: ToolCall): ToolResult => ({
  type: "tool_result",
  callId: call.callId,
  ok: true,
  output: { from: call.tool },
});

/**
 * A run's steps as plain functions that write each call to `log` ("plan", "model@3", "tool search_documents",
 * "record c1,c2", ...), with `plan` answering from `plans` in turn. Override any step to change what it does.
 */
export function fakeSteps(plans: Plan[], log: string[] = [], overrides: Partial<RunSteps> = {}) {
  let next = 0;
  const steps: RunSteps = {
    async plan() {
      log.push("plan");
      const plan = plans[next++];
      if (!plan) throw new Error(`plan was called ${next} times; the test scripted ${plans.length}`);
      return plan;
    },
    async modelTurn(version) {
      log.push(`model@${version}`);
      return "done";
    },
    async tool(call) {
      log.push(`tool ${call.tool}`);
      return { kind: "result", result: resultOf(call) };
    },
    async delegate(call, siblings, batch) {
      log.push(`delegate ${call.callId} ${siblings}/${batch}`);
      return { kind: "result", result: resultOf(call) };
    },
    async record(results) {
      log.push(`record ${results.map((r) => r.callId).join(",")}`);
    },
    async approval(call, version) {
      log.push(`approval ${call.callId}@${version}`);
      return null;
    },
    async expire(approvalId) {
      log.push(`expire ${approvalId}`);
      return true;
    },
    async fail(reason) {
      log.push(`fail ${reason}`);
    },
    ...overrides,
  };
  return { steps, log, planned: () => next };
}

/** The run's hook, fed by hand: `send` delivers a signal to whoever reads next. */
export function fakeSignals() {
  const queued: RunSignal[] = [];
  const readers: Array<(result: IteratorResult<RunSignal>) => void> = [];
  let reads = 0;
  const incoming: AsyncIterator<RunSignal> = {
    next() {
      reads++;
      return new Promise((resolve) => {
        const signal = queued.shift();
        if (signal) resolve({ value: signal, done: false });
        else readers.push(resolve);
      });
    },
  };
  return {
    signals: new RunSignals(incoming),
    send(signal: RunSignal) {
      const reader = readers.shift();
      if (reader) reader({ value: signal, done: false });
      else queued.push(signal);
    },
    /** How many `next()` calls the run's hook has had. */
    reads: () => reads,
  };
}

interface FakeHook {
  token: string;
  resume(payload: unknown): void;
  disposed: boolean;
}

/**
 * Workflow's hooks and sleep, by hand: `hooks` holds each hook made (resume it), `sleeps` each sleep asked for
 * (end them with `wake`). Both write to `log` ("hook <token>", "sleep <iso>") as they're made.
 */
export function fakeDurable(log: string[] = []) {
  const hooks: FakeHook[] = [];
  const sleeps: Array<{ until: Date; end(): void }> = [];
  const durable: Durable = {
    createHook<T>({ token }: { token: string }): Hook<T> {
      log.push(`hook ${token}`);
      let resume!: (payload: T) => void;
      const payload = new Promise<T>((resolve) => (resume = resolve));
      const hook: FakeHook = { token, resume: (value) => resume(value as T), disposed: false };
      hooks.push(hook);
      return {
        token,
        // oxlint-disable-next-line unicorn/no-thenable -- Workflow's Hook is a thenable
        then: payload.then.bind(payload) as Hook<T>["then"],
        getConflict: async () => null,
        dispose: () => void (hook.disposed = true),
        [Symbol.dispose]: () => void (hook.disposed = true),
        async *[Symbol.asyncIterator]() {
          yield await payload;
        },
      };
    },
    sleep(until) {
      log.push(`sleep ${until.toISOString()}`);
      return new Promise<void>((resolve) => sleeps.push({ until, end: resolve }));
    },
  };
  return {
    durable,
    hooks,
    sleeps,
    /** Ends every sleep, as `wakeUp` does in a Workflow test. */
    wake: () => sleeps.forEach((sleep) => sleep.end()),
  };
}

/** What Grace's run does next, as the plan step reads it from the world: section 15.6's run, cut down. */
export type GracePlan =
  | { kind: "model"; turn: number }
  | { kind: "tools"; calls: string[] }
  | { kind: "approval"; call: string }
  | { kind: "waiting"; approval: string }
  | { kind: "final"; status: "succeeded" };

const GRACE_SCRIPT: GracePlan[] = [
  { kind: "model", turn: 0 },
  { kind: "tools", calls: ["make_plan"] },
  { kind: "model", turn: 1 },
  { kind: "tools", calls: ["search_documents", "find_person"] },
  { kind: "model", turn: 2 },
  { kind: "tools", calls: ["read_document"] },
  { kind: "model", turn: 3 },
  { kind: "approval", call: "send_mail" },
  { kind: "waiting", approval: "approval-1" },
  { kind: "tools", calls: ["send_mail"] },
  { kind: "model", turn: 4 },
  { kind: "final", status: "succeeded" },
];

/** A crash: the server died after a step's work and before its result was logged. */
export class Crash extends Error {
  override name = "Crash";
}

/**
 * Grace's run's world, standing in for Postgres and fake-workspace: the plan reads where the run is, each piece of
 * work moves it on once per step id (as `run_events.step_key` does), and a mail is kept once per key (as
 * fake-workspace does). `crashAfter(n)` makes the nth piece of work from now throw a `Crash` once it's done.
 */
export function graceWorld(runId = "run-grace") {
  let at = 0;
  let crashIn: number | null = null;
  const done = new Set<string>();
  const world = {
    /** Model calls made: each is billed, even one whose turn was already written. */
    modelCalls: 0,
    /** Every send that reached fake-workspace, by its idempotency key. */
    sends: [] as string[],
    get mails() {
      return [...new Set(world.sends)];
    },
    crashAfter(n: number) {
      crashIn = n;
    },
    plan: async (): Promise<GracePlan> => GRACE_SCRIPT[at],
    /** One piece of work under `stepId`: moves the run on once, however many times the step runs. */
    async work(stepId: string, what: () => void, moves: boolean): Promise<string> {
      what();
      if (moves && !done.has(stepId)) {
        done.add(stepId);
        at++;
      }
      if (crashIn !== null && --crashIn === 0) {
        crashIn = null;
        throw new Crash(`the server died after ${stepId}`);
      }
      return stepId;
    },
    modelTurn: (stepId: string) => world.work(stepId, () => world.modelCalls++, true),
    tool: (stepId: string, tool: string) =>
      world.work(stepId, () => tool === "send_mail" && world.sends.push(`agent:${runId}:${stepId}`), false),
    move: (stepId: string) => world.work(stepId, () => {}, true),
  };
  return world;
}

export type GraceWorld = ReturnType<typeof graceWorld>;

/** Grace's run as a workflow body, in section 15.6's terms: the same loop as `driveRun`, every effect a step. */
export async function graceBody(run: RunContext, world: GraceWorld): Promise<string> {
  for (;;) {
    const plan = await run.step("plan", [], () => world.plan());
    if (plan.kind === "final") return plan.status;
    if (plan.kind === "model") await run.step("model_turn", [plan.turn], ({ stepId }) => world.modelTurn(stepId));
    else if (plan.kind === "approval") {
      await run.step("request_approval", [plan.call], ({ stepId }) => world.move(stepId));
    } else if (plan.kind === "waiting") {
      await run.step("approval_decided", [plan.approval], ({ stepId }) => world.move(stepId));
    } else {
      await Promise.all(plan.calls.map((tool) => run.step("tool", [tool], ({ stepId }) => world.tool(stepId, tool))));
      await run.step("record", [plan.calls], ({ stepId }) => world.move(stepId));
    }
  }
}
