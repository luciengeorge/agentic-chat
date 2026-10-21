// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { RunEventData, RunStatus } from "#learn/agent/types";

import type { Fetch, SmokeTargets } from "./smoke";

import { DEFAULT_CORPUS_DIR } from "../../servers/fake-workspace/app";
import { checkAgent, checkApproval } from "./smoke-agent";
import { refused } from "./test-repo";

const APP = "http://localhost:3000";
const WORKSPACE = "http://localhost:8100";
const usage = { inputTokens: 1000, outputTokens: 50, reasoningTokens: 0 };

/** How a run behaves: what it does before asking, and after each decision. */
type Behaviour = {
  /** The first turn's plan writes; null for no plan. */
  plan?: string[] | null;
  /** Ask for a send_mail approval; false ends the run without asking. */
  asks?: boolean;
  /** Mails it sends once approved (1 normally). */
  sends?: number;
  /** Asks again after a rejection. */
  asksAgain?: boolean;
  /** The status it ends with after a rejection. */
  afterReject?: RunStatus;
};

type Run = { id: string; events: RunEventData[]; status: RunStatus; behaviour: Behaviour; approvals: number };

/** The agent routes and fake-workspace's mail control, simulated: runs follow their behaviour. */
function stack(behaviour: (text: string) => Behaviour, { rateLimited = 0 } = {}) {
  const runs = new Map<string, Run>();
  const mails: { to: string[]; subject: string; idempotencyKey: string }[] = [];
  const approvalRun = new Map<string, Run>();
  let limited = rateLimited;

  const push = (run: Run, ...data: RunEventData[]) => {
    for (const d of data) {
      run.events.push(d);
      if (d.type === "status") run.status = d.to;
    }
  };
  const ask = (run: Run) => {
    const approvalId = `00000000-0000-4000-8000-${String(approvalRun.size + 1).padStart(12, "0")}`;
    approvalRun.set(approvalId, run);
    run.approvals += 1;
    const call = {
      callId: `c${run.approvals}`,
      tool: "send_mail",
      input: { to: ["tom.whitfield@kestrelpay.example"] },
    };
    push(
      run,
      { type: "assistant_turn", text: "", toolCalls: [call], usage },
      { type: "approval_requested", approvalId, call, expiresAt: "2026-10-21T00:00:00Z" },
      { type: "status", from: "running", to: "waiting" },
    );
  };
  const finish = (run: Run, to: RunStatus) => {
    push(run, { type: "assistant_turn", text: "Done.", toolCalls: [], usage }, { type: "status", from: "running", to });
  };

  const start = (id: string, text: string) => {
    const b = { plan: ["send_mail"], asks: true, sends: 1, afterReject: "succeeded" as RunStatus, ...behaviour(text) };
    const run: Run = { id, events: [], status: "queued", behaviour: b, approvals: 0 };
    runs.set(id, run);
    push(run, { type: "user_message", messageId: "m", text }, { type: "status", from: "queued", to: "running" });
    const plan = {
      callId: "plan",
      tool: "make_plan",
      input: { goal: "g", steps: [], writes: (b.plan ?? []).map((tool) => ({ tool })) },
    };
    push(run, { type: "assistant_turn", text: "", toolCalls: b.plan === null ? [] : [plan], usage });
    setTimeout(() => (b.asks ? ask(run) : finish(run, "succeeded")), 5);
  };

  const decide = (approvalId: string, decision: "approved" | "rejected") => {
    const run = approvalRun.get(approvalId)!;
    push(
      run,
      { type: "approval_decided", approvalId, decision, by: "u" },
      { type: "status", from: "waiting", to: "running" },
    );
    setTimeout(() => {
      if (decision === "approved") {
        for (let i = 0; i < run.behaviour.sends!; i++) {
          mails.push({
            to: ["tom.whitfield@kestrelpay.example"],
            subject: "s",
            idempotencyKey: `agent:${run.id}:step_${i}`,
          });
        }
        finish(run, "succeeded");
      } else if (run.behaviour.asksAgain && run.approvals < 2) ask(run);
      else finish(run, run.behaviour.afterReject!);
    }, 5);
  };

  const stream = (run: Run) => {
    let sent = 0;
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        for (;;) {
          if (sent < run.events.length) {
            const chunk = run.events
              .slice(sent)
              .map(
                (data, i) =>
                  `id: ${sent + i + 1}\ndata: ${JSON.stringify({ runId: run.id, seq: sent + i + 1, at: "", data })}\n\n`,
              )
              .join("");
            sent = run.events.length;
            controller.enqueue(encoder.encode(`event: token\ndata: {"delta":"x"}\n\n: heartbeat\n\n${chunk}`));
            return;
          }
          if (["succeeded", "failed", "cancelled", "timed_out"].includes(run.status)) return controller.close();
          await new Promise((r) => setTimeout(r, 2));
        }
      },
    });
  };

  const fetch: Fetch = async (url, init) => {
    const { pathname } = new URL(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.startsWith(WORKSPACE)) {
      if (pathname === "/_control/mail") return Response.json({ value: mails });
      return new Response("Not Found", { status: 404 });
    }
    if (pathname === "/api/auth/sign-in/email") {
      return new Response("{}", { headers: { "set-cookie": "session=abc; Path=/; HttpOnly" } });
    }
    if (pathname === "/api/auth/sign-out") return new Response("{}");
    if (new Headers(init?.headers).get("cookie") !== "session=abc") return Response.json({}, { status: 401 });
    if (pathname === "/api/runs") {
      if (limited-- > 0)
        return Response.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "0" } });
      start(body.id, body.message.text);
      return Response.json({ id: body.id, seq: 1, duplicate: false }, { status: 202 });
    }
    let match = pathname.match(/^\/api\/runs\/([^/]+)\/stream$/);
    if (match) return new Response(stream(runs.get(match[1])!), { headers: { "content-type": "text/event-stream" } });
    match = pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
    if (match) {
      const run = runs.get(match[1])!;
      push(run, { type: "status", from: run.status, to: "cancelled", reason: "cancelled by the user" });
      return Response.json({ id: run.id, status: "cancelled" }, { status: 202 });
    }
    match = pathname.match(/^\/api\/approvals\/([^/]+)$/);
    if (match) {
      decide(match[1], body.decision);
      return Response.json({ id: match[1], decision: body.decision });
    }
    return new Response("Not Found", { status: 404 });
  };
  return { fetch, mails, runs };
}

const targets = (fetch: Fetch): SmokeTargets => ({
  databaseUrl: "",
  appUrl: APP,
  workspaceUrl: WORKSPACE,
  corpusDir: DEFAULT_CORPUS_DIR,
  fetch,
});

describe("checkAgent", () => {
  it("passes a run that plans the mail, asks, is approved, succeeds and sends one mail to Tom", async () => {
    const { fetch } = stack(() => ({}));
    expect(await checkAgent(targets(fetch))).toMatch(
      /^run [0-9a-f-]+: planned send_mail, approved, succeeded; 1 mail to Tom with key agent:[0-9a-f-]+:step_0; 3000 tokens in, 150 out$/,
    );
  });

  it("waits out a rate limit on the run bucket", async () => {
    const { fetch } = stack(() => ({}), { rateLimited: 2 });
    expect(await checkAgent(targets(fetch))).toContain("succeeded");
  });

  it("fails a run that ends without asking, one with no planned mail, and one that sends twice", async () => {
    await expect(checkAgent(targets(stack(() => ({ asks: false })).fetch))).rejects.toThrow(
      /succeeded ended before asking for approval: user_message, ->running, make_plan, answer, ->succeeded/,
    );
    await expect(checkAgent(targets(stack(() => ({ plan: null })).fetch))).rejects.toThrow(/planned \[nothing\]/);
    await expect(checkAgent(targets(stack(() => ({ sends: 2 })).fetch))).rejects.toThrow(
      /sent 2 mails with its key, want 1/,
    );
  });

  it("says when the app isn't running", async () => {
    await expect(checkAgent(targets(refused))).rejects.toThrow("is `pnpm dev` running?");
  });
});

describe("checkApproval", () => {
  it("passes a rejected run that ends without sending and a run cancelled while waiting", async () => {
    const { fetch, runs } = stack(() => ({}));
    expect(await checkApproval(targets(fetch))).toMatch(
      /^run \S+: 1 rejection\(s\) \(1 decided\), succeeded, no mail; run \S+: cancelled while waiting, no mail$/,
    );
    expect([...runs.values()].map((r) => r.status).sort()).toEqual(["cancelled", "succeeded"]);
  });

  it("asks fake-workspace nothing with mailbox: false, as on a deploy", async () => {
    const { fetch } = stack(() => ({}));
    const asked: string[] = [];
    const watched: Fetch = (url, init) => (asked.push(url), fetch(url, init));
    expect(await checkApproval(targets(watched), { mailbox: false })).toMatch(
      /^run \S+: 1 rejection\(s\) \(1 decided\), succeeded; run \S+: cancelled while waiting$/,
    );
    expect(asked.filter((url) => url.startsWith(WORKSPACE))).toEqual([]);
  });

  it("rejects a run that asks again, and fails one that ends badly after the rejection", async () => {
    expect(await checkApproval(targets(stack(() => ({ asksAgain: true })).fetch))).toMatch(/2 rejection\(s\)/);
    await expect(checkApproval(targets(stack(() => ({ afterReject: "failed" })).fetch))).rejects.toThrow(
      /the rejected run \S+ ended failed/,
    );
  });
});
