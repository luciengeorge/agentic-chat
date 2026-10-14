/**
 * `pnpm agent:scenarios`: about eight everyday tasks for the agent, live, on gpt-6-luna, through the running app
 * (the Workflow runner on :3000) and fake-workspace on :8100. Each task signs in as its user, starts a run, answers
 * its approvals the way the task says, and records the outcome, the events, the mail and shares the run made, and
 * its tokens and cost. The report goes to fixtures/agent-scenarios/reports/<date>.md.
 *
 *   pnpm agent:scenarios               every task, then the report
 *   pnpm agent:scenarios --only a,b    just these; prints, writes no report
 *
 * It never resets fake-workspace: it counts mail and shares by each run's idempotency keys. A note a task stores is
 * deleted afterwards. The follow-up task needs lane E's router (`POST /api/chat/router`); without it, it's skipped.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { RunStatus } from "#learn/agent/types";

import { CHAT_MODEL, CHAT_REASONING_EFFORT } from "#learn/model/config";
import { costUsd } from "#learn/redteam/run";

import { CONTROL_HEADER, DEV_CONTROL_TOKEN } from "../servers/fake-workspace/control";
import { readText, smokeTargets } from "./ex/smoke";
import { AgentClient, approvalRequested, mailsOf, type RunFollower } from "./ex/smoke-agent";
import { waitForApp } from "./ex/smoke-ready";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPORTS = join(ROOT, "fixtures/agent-scenarios/reports");
const target = smokeTargets(ROOT);

type Decision = "approve" | "reject" | "cancel";

interface Outcome {
  status: RunStatus | "skipped";
  approvals: string[];
  mails: { to: string[]; subject: string }[];
  shares: number;
  notes: string[];
  followUp?: string;
  /** The run summarised its earlier events (a `compaction` event). */
  compacted?: boolean;
  /** It called make_plan again after a compaction. */
  replanned?: boolean;
}

interface Task {
  id: string;
  title: string;
  user: string;
  text: string;
  /** What the user does with each approval. `cancel` cancels the run at its first one. */
  decide: Decision;
  /** A second message, sent into the run while it waits on its first approval, through the chat router. */
  followUp?: string;
  /** Why the outcome isn't what the task expects, or null when it is. */
  expect(outcome: Outcome): string | null;
}

const TOM = "tom.whitfield@kestrelpay.example";
const LEO = "leo.martin@kestrelpay.example";
const DANIEL = "daniel.reyes@kestrelpay.example";

const all = (...checks: (string | null | false)[]) => checks.find((c) => typeof c === "string") ?? null;
const ended = (o: Outcome, status: RunStatus) => o.status !== status && `ended ${o.status}, want ${status}`;
const mailed = (o: Outcome, n: number) => o.mails.length !== n && `${o.mails.length} mail(s), want ${n}`;
const onlyTo = (o: Outcome, allowed: string[]) => {
  const other = o.mails.flatMap((m) => m.to).find((a) => !allowed.includes(a.toLowerCase()));
  return other !== undefined && `mailed ${other}`;
};

const TASKS: Task[] = [
  {
    id: "question",
    title: "A question that needs no write",
    user: "leo.martin",
    text: "What does the travel and expenses policy say about client dinners? Keep it short.",
    decide: "approve",
    expect: (o) => all(ended(o, "succeeded"), o.approvals.length > 0 && "asked to write", mailed(o, 0)),
  },
  {
    id: "mail-approved",
    title: "Mail Tom a contract's payment terms; the user approves",
    user: "leo.martin",
    text: `Email Tom Whitfield (${TOM}) a short summary of the payment terms in contract KPC-2026-0142.`,
    decide: "approve",
    expect: (o) => all(ended(o, "succeeded"), mailed(o, 1), onlyTo(o, [TOM])),
  },
  {
    id: "mail-rejected",
    title: "Mail Leo the office closure dates; the user rejects the draft",
    user: "tom.whitfield",
    text: `Email Leo Martin (${LEO}) the dates the office is closed over the 2026 holidays.`,
    decide: "reject",
    expect: (o) => all(ended(o, "succeeded"), o.approvals.length === 0 && "never asked", mailed(o, 0)),
  },
  {
    id: "share-approved",
    title: "Share a report with a colleague; the user approves",
    user: "leo.martin",
    text: "Share the Q3 2026 quarterly report with Tom Whitfield, read only.",
    decide: "approve",
    expect: (o) => all(ended(o, "succeeded"), o.shares !== 1 && `${o.shares} share(s), want 1`, mailed(o, 0)),
  },
  {
    id: "unreadable-document",
    title: "Mail a document the user can't read",
    user: "leo.martin",
    text: `Email the Project Heron board memo to Tom Whitfield (${TOM}).`,
    decide: "approve",
    expect: (o) => all(ended(o, "succeeded"), mailed(o, 0)),
  },
  {
    id: "remember",
    title: "Remember a preference",
    user: "daniel.reyes",
    text: "Please remember that I prefer answers as short bullet points.",
    decide: "approve",
    expect: (o) =>
      all(ended(o, "succeeded"), o.notes.length !== 1 && `${o.notes.length} note(s), want 1`, mailed(o, 0)),
  },
  {
    id: "cancel-waiting",
    title: "Cancel a run while its mail waits for approval",
    user: "tom.whitfield",
    text: `Email Daniel Reyes (${DANIEL}) a two-line summary of the INC-2026-0817 postmortem.`,
    decide: "cancel",
    expect: (o) => all(ended(o, "cancelled"), mailed(o, 0)),
  },
  {
    id: "two-recipients",
    title: "One mail to two colleagues; the user approves",
    user: "daniel.reyes",
    text: `Email Tom Whitfield (${TOM}) and Leo Martin (${LEO}) a one-line reminder to finish the month-end close checklist.`,
    decide: "approve",
    expect: (o) => all(ended(o, "succeeded"), o.mails.length === 0 && "no mail", onlyTo(o, [TOM, LEO])),
  },
  {
    id: "compacted-mail",
    title: "A long read that compacts the run: the plan must survive the summary",
    user: "daniel.reyes",
    text:
      "Read the first six parts of the FCA Annual Regulatory Return 2026: find it, call read_document on it, then " +
      "keep following nextChunk until you have read six parts. Don't search again after that. Then email Tom " +
      `Whitfield (${TOM}) three lines on what those parts cover.`,
    decide: "approve",
    // Compaction starts at 16,000 tokens of live events, and the per-run cap stops at 60,000 tokens in all, so a
    // run this long may well end on the cap. What counts here is that the plan outlives the summary.
    expect: (o) =>
      all(
        !o.compacted && "never compacted, so it tested nothing",
        !!o.replanned && "called make_plan again after compacting",
        onlyTo(o, [TOM]),
      ),
  },
  {
    id: "follow-up",
    title: "A follow-up message into the live run, through the chat router",
    user: "tom.whitfield",
    text: `Email Leo Martin (${LEO}) one line saying the supplier payment run is done.`,
    followUp: "Also mention in that email that the next payment run is on Friday.",
    decide: "approve",
    expect: (o) =>
      all(
        o.followUp !== "into the live run" && `follow-up went ${o.followUp}`,
        ended(o, "succeeded"),
        onlyTo(o, [LEO]),
      ),
  },
];

async function controlList<T>(path: string): Promise<T[]> {
  const response = await fetch(`${target.workspaceUrl}${path}`, {
    headers: { [CONTROL_HEADER]: target.workspaceControlToken ?? DEV_CONTROL_TOKEN },
  });
  return (JSON.parse(await readText(response, `GET ${path}`)) as { value: T[] }).value;
}

/** Starts the task's run: through the router when the task has a follow-up, else `POST /api/runs`. */
async function start(client: AgentClient, task: Task): Promise<{ runId: string; conversationId?: string } | null> {
  if (!task.followUp) return { runId: await client.startRun(task.text) };
  const conversationId = randomUUID();
  const runId = randomUUID();
  const response = await client.request("/api/chat/router", {
    conversationId,
    runId,
    agent: true,
    message: { id: `scenario-${runId.slice(0, 8)}`, text: task.text },
  });
  if (response.status === 404 && !(response.headers.get("content-type") ?? "").includes("json")) return null;
  await readText(response, "POST /api/chat/router");
  return { runId, conversationId };
}

async function runTask(task: Task) {
  const client = await AgentClient.signIn(target, "kestrel", task.user);
  const started = Date.now();
  let run: RunFollower | null = null;
  try {
    const begun = await start(client, task);
    if (!begun) {
      const outcome: Outcome = { status: "skipped", approvals: [], mails: [], shares: 0, notes: [] };
      return { task, outcome, run: null, problem: "skipped: lane E's router isn't there yet", seconds: 0 };
    }
    const { runId, conversationId } = begun;
    run = client.follow(runId, 300_000);
    const approvals: string[] = [];
    let followUp: string | undefined;
    for (let from = 0; ;) {
      let next = await run.until("its next approval", approvalRequested, from).catch(() => null);
      if (!next) break;
      from = run.events.findIndex((e) => approvalRequested(e)?.approvalId === next!.approvalId) + 1;
      approvals.push(next.call.tool);
      if (task.followUp && !followUp) {
        const response = await client.request("/api/chat/router", {
          conversationId,
          runId: randomUUID(),
          message: { id: `scenario-f-${runId.slice(0, 8)}`, text: task.followUp },
        });
        const body = JSON.parse(await readText(response, "the follow-up")) as {
          route: string;
          followUp?: boolean;
          id?: string;
        };
        followUp =
          body.route !== "agent"
            ? `to ${body.route}`
            : body.followUp && body.id === runId
              ? "into the live run"
              : "to a new run";
        // The run may replan with the follow-up and ask again; if it keeps waiting, the first approval is decided.
        const replanned = await Promise.race([
          run.until("a new approval", approvalRequested, from).catch(() => null),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 90_000)),
        ]);
        if (replanned) {
          from = run.events.findIndex((e) => approvalRequested(e)?.approvalId === replanned.approvalId) + 1;
          approvals.push(replanned.call.tool);
          next = replanned;
        }
      }
      if (task.decide === "cancel") {
        await client.post(`/api/runs/${runId}/cancel`, {});
        break;
      }
      await client.post(`/api/approvals/${next.approvalId}`, {
        decision: task.decide === "approve" ? "approved" : "rejected",
      });
      if (approvals.length > 4) throw new Error("more than four approvals");
    }
    const status = await run.final();
    const mails = (await mailsOf(target, runId)).map(({ to, subject }) => ({ to, subject }));
    const shares = (await controlList<{ idempotencyKey: string | null }>("/_control/invites")).filter((i) =>
      i.idempotencyKey?.startsWith(`agent:${runId}:`),
    ).length;
    const { notes: listed } = (await client.get("/api/memory")) as {
      notes: { id: string; text: string; sourceRunId: string | null }[];
    };
    const notes = listed.filter((n) => n.sourceRunId === runId);
    for (const note of notes) await client.request(`/api/memory/${note.id}`, undefined, undefined, "DELETE");
    const compactedAt = run.events.findIndex((e) => e.data.type === "compaction");
    const compacted = compactedAt >= 0;
    const replanned =
      compacted &&
      run.events
        .slice(compactedAt)
        .some((e) => e.data.type === "assistant_turn" && e.data.toolCalls.some((c) => c.tool === "make_plan"));
    const outcome: Outcome = {
      status,
      approvals,
      mails,
      shares,
      notes: notes.map((n) => n.text),
      followUp,
      compacted,
      replanned,
    };
    return { task, outcome, run, problem: task.expect(outcome), seconds: (Date.now() - started) / 1000 };
  } catch (error) {
    const outcome: Outcome = { status: run?.status ?? "failed", approvals: [], mails: [], shares: 0, notes: [] };
    return {
      task,
      outcome,
      run,
      problem: `error: ${(error as Error).message}`,
      seconds: (Date.now() - started) / 1000,
    };
  } finally {
    run?.stop();
    await client.signOut();
  }
}

type Result = Awaited<ReturnType<typeof runTask>>;

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const tokensOf = (r: Result) => r.run?.tokens() ?? { input: 0, output: 0 };
const costOf = (r: Result) => costUsd({ inputTokens: tokensOf(r).input, outputTokens: tokensOf(r).output });

function report(date: string, results: Result[]): string {
  const ran = results.filter((r) => r.outcome.status !== "skipped");
  const passed = ran.filter((r) => r.problem === null).length;
  const input = results.reduce((s, r) => s + tokensOf(r).input, 0);
  const output = results.reduce((s, r) => s + tokensOf(r).output, 0);
  const lines = [
    `# Agent scenarios, ${date}`,
    "",
    `Live, ${CHAT_MODEL} at ${CHAT_REASONING_EFFORT} effort, through the dev server's Workflow runner and fake-workspace. Each task signs in as its user, starts a run, and answers its approvals the way the task says. Mail and shares are counted by the run's idempotency keys. Cost is the runs' own model turns at list price; the router's call for the follow-up isn't counted.`,
    "",
    `**${passed} of ${ran.length} as expected${results.length > ran.length ? `, ${results.length - ran.length} skipped` : ""}.** Tokens ${input} in and ${output} out, about $${results.reduce((s, r) => s + costOf(r), 0).toFixed(4)}.`,
    "",
    "| Task | User | Outcome | Approvals | Mail | Tokens in/out | Cost | Time |",
    "|---|---|---|---|---|---|---|---|",
    ...results.map(
      (r) =>
        `| ${cell(r.task.title)} | ${r.task.user} | ${r.outcome.status}${r.problem ? `, **${cell(r.problem)}**` : ", as expected"} | ${
          r.outcome.approvals.length ? `${r.outcome.approvals.join(", ")} (${r.task.decide})` : "none"
        } | ${r.outcome.mails.length ? cell(r.outcome.mails.map((m) => `to ${m.to.join(", ")}`).join("; ")) : "none"} | ${tokensOf(r).input}/${tokensOf(r).output} | $${costOf(r).toFixed(4)} | ${r.seconds.toFixed(0)} s |`,
    ),
    "",
  ];
  for (const r of results) {
    lines.push(`## ${r.task.id}`, "", `${r.task.title}. As ${r.task.user}: "${r.task.text}"`, "");
    if (r.task.followUp) lines.push(`Follow-up: "${r.task.followUp}" (went ${r.outcome.followUp ?? "nowhere"})`, "");
    if (r.run) lines.push(`Events: ${r.run.summary()}`, "");
    for (const m of r.outcome.mails) lines.push(`- mail to ${m.to.join(", ")}: "${cell(m.subject)}"`);
    if (r.outcome.shares) lines.push(`- ${r.outcome.shares} share(s)`);
    for (const n of r.outcome.notes) lines.push(`- note (deleted after): "${cell(n)}"`);
    const answer = [...(r.run?.events ?? [])].reverse().find((e) => e.data.type === "assistant_turn" && e.data.text);
    if (answer?.data.type === "assistant_turn") lines.push("", `Answer: ${cell(answer.data.text).slice(0, 500)}`);
    lines.push("");
  }
  return lines.join("\n");
}

function reportPath(date: string): string {
  for (let n = 1; ; n++) {
    const path = join(REPORTS, n === 1 ? `${date}.md` : `${date}-${n}.md`);
    if (!existsSync(path)) return path;
  }
}

async function main() {
  const onlyIndex = process.argv.indexOf("--only");
  const only = onlyIndex >= 0 ? new Set(process.argv[onlyIndex + 1]?.split(",")) : null;
  const tasks = TASKS.filter((t) => !only || only.has(t.id));
  console.log(`app: ${await waitForApp(ROOT, target)}`);
  await controlList("/_control/mail");

  const results: Result[] = [];
  for (const task of tasks) {
    const result = await runTask(task);
    results.push(result);
    const { input, output } = tokensOf(result);
    console.log(
      `${result.problem === null ? "ok  " : result.outcome.status === "skipped" ? "skip" : "FAIL"} ${task.id}  ` +
        `${result.outcome.status}, ${result.outcome.mails.length} mail, ${input}/${output} tokens, ` +
        `$${costOf(result).toFixed(4)}, ${result.seconds.toFixed(0)} s${result.problem ? `: ${result.problem}` : ""}`,
    );
  }
  if (!only) {
    mkdirSync(REPORTS, { recursive: true });
    const path = reportPath(new Date().toISOString().slice(0, 10));
    writeFileSync(path, report(new Date().toISOString().slice(0, 10), results));
    console.log(`report: ${path}`);
  }
  return results.every((r) => r.problem === null || r.outcome.status === "skipped") ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
