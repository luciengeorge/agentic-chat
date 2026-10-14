// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { scriptedTurns } from "#learn/model/testing";

import type { AgentTool, RunEventData, Screen, ToolCall } from "./types";

import { DEFAULT_CAPS } from "./caps";
import { approvalNeeded, decide, modelTurn, type RunGuard, runTool } from "./loop";
import { inMemoryRun } from "./loop-testing";
import { currentPlan, documentMatches, type Plan, PLAN_TOOL, planTool, targetMatches, uncovered } from "./plan";
import { planPolicy } from "./policy";

const viewer = { tenantId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222" };
const usage = { inputTokens: 100, outputTokens: 10, reasoningTokens: 0 };
const TOM = "Tom Whitfield <tom.whitfield@kestrelpay.example>";

const sent: unknown[] = [];
const write = (name: string, needsApproval = true): AgentTool<Record<string, unknown>, { ok: true }> => ({
  name,
  description: name,
  input: z.record(z.string(), z.unknown()),
  effect: "write",
  needsApproval: () => needsApproval,
  execute: async (input) => {
    sent.push({ name, input });
    return { ok: true };
  },
});
const read: AgentTool<{ query: string }, { hits: [] }> = {
  name: "search_documents",
  description: "search",
  input: z.object({ query: z.string() }),
  effect: "read",
  needsApproval: () => false,
  execute: async () => ({ hits: [] }),
};
const TOOLS = [planTool(), read, write("send_mail"), write("share_document"), write("remember", false)] as AgentTool[];
const gate = approvalNeeded(TOOLS, viewer, "run-1");

const plan = (...writes: Plan["writes"]): ToolCall => ({
  callId: "plan",
  tool: PLAN_TOOL,
  input: { goal: "g", steps: [], writes },
});
const mail = (callId: string, to: string[], screen: Screen = { recipients: [TOM] }): ToolCall => ({
  callId,
  tool: "send_mail",
  input: { to, subject: "s", body: "b", attachmentDocumentIds: [] },
  screen,
});
const turn = (...toolCalls: ToolCall[]): RunEventData => ({ type: "assistant_turn", text: "", toolCalls, usage });
const ask = (text = "hi"): RunEventData => ({ type: "user_message", messageId: text, text });
const ok = (callId: string): RunEventData => ({ type: "tool_result", callId, ok: true, output: null });

function log(...data: RunEventData[]) {
  const run = inMemoryRun();
  run.append(...data);
  return run.events;
}

const mailTom = plan({ tool: "send_mail", targets: ["Tom"], documents: [] });

describe("the plan", () => {
  it("is the make_plan call in the first turn after the latest user message", () => {
    expect(currentPlan(log(ask(), turn(mailTom)))).toMatchObject({ writes: [{ tool: "send_mail" }] });
    expect(currentPlan(log(ask(), turn(), turn(mailTom)))).toBeNull();
    expect(currentPlan(log(ask(), turn(mailTom), ok("plan"), ask("again")))).toBeNull();
    expect(currentPlan(log(ask(), turn({ ...mailTom, input: { goal: 1 } })))).toBeNull();
  });

  it("matches targets as the user named them against what the guardrails resolved", () => {
    expect(targetMatches("Tom", [TOM])).toBe(true);
    expect(targetMatches("tom whitfield", [TOM])).toBe(true);
    expect(targetMatches("tom.whitfield@kestrelpay.example", [TOM])).toBe(true);
    expect(targetMatches("Tom Becker", [TOM])).toBe(false);
    expect(targetMatches("the team", [TOM])).toBe(false);
    expect(targetMatches("Finance", ["/Kestrel/Finance"])).toBe(true);
    expect(documentMatches("the Q3 report", ["Q3 report.pdf (/Finance/Reports/Q3 report.pdf)"])).toBe(true);
    expect(documentMatches("the Heron memo", ["Q3 report.pdf (/Finance/Reports/Q3 report.pdf)"])).toBe(false);
  });

  it("covers a mail only when every recipient is planned, and a share only with its document and recipient", () => {
    const p = { goal: "g", steps: [], writes: [{ tool: "send_mail" as const, targets: ["Tom"], documents: [] }] };
    expect(uncovered(p, mail("m", ["tom.whitfield@kestrelpay.example"]))).toBeNull();
    expect(
      uncovered(
        p,
        mail("m", ["tom.whitfield@kestrelpay.example", "mia.chen@kestrelpay.example"], {
          recipients: [TOM, "Mia Chen <mia.chen@kestrelpay.example>"],
        }),
      ),
    ).toMatch(/mia.chen/);
    const share = (documents: string[]): ToolCall => ({
      callId: "s",
      tool: "share_document",
      input: {},
      screen: { recipients: [TOM], documents },
    });
    const sharePlan = {
      goal: "g",
      steps: [],
      writes: [{ tool: "share_document" as const, targets: ["Tom"], documents: ["Q3 report"] }],
    };
    expect(uncovered(sharePlan, share(["Q3 report.pdf (/Finance/Reports/Q3 report.pdf)"]))).toBeNull();
    expect(uncovered(sharePlan, share(["Salaries.xlsx (/HR/Salaries.xlsx)"]))).toMatch(/doesn't name/);
    expect(uncovered(p, share([]))).toMatch(/no share_document/);
  });
});

describe("the policy", () => {
  const check = (call: ToolCall, ...data: RunEventData[]) =>
    planPolicy.check(call, { events: log(...data), tool: TOOLS.find((t) => t.name === call.tool) });

  it("always allows reads, and make_plan only in the planning turn", () => {
    const search: ToolCall = { callId: "s", tool: "search_documents", input: { query: "q" } };
    expect(check(search, ask(), turn(search))).toEqual({ kind: "allow" });
    expect(check(mailTom, ask(), turn(mailTom))).toEqual({ kind: "allow" });
    const late = { ...mailTom, callId: "plan-2" };
    expect(check(late, ask(), turn(mailTom), ok("plan"), turn(late))).toMatchObject({
      kind: "deny",
      reason: expect.stringContaining("Replanning needs the user"),
    });
  });

  it("allows a planned write that passed the guardrails, and sends a flagged one to the user with the reason", () => {
    const m = mail("m", ["tom.whitfield@kestrelpay.example"]);
    expect(check(m, ask(), turn(mailTom), ok("plan"), turn(m))).toEqual({ kind: "allow" });
    const flagged = mail("m", ["tom.whitfield@kestrelpay.example"], { recipients: [TOM], flag: "quotes X" });
    expect(check(flagged, ask(), turn(mailTom), ok("plan"), turn(flagged))).toEqual({
      kind: "approve",
      reason: "quotes X",
    });
  });

  it("refuses an unplanned write, one with no plan, an unscreened one and one the guardrails denied", () => {
    const m = mail("m", ["tom.whitfield@kestrelpay.example"]);
    const deny = (reason: RegExp) => ({ kind: "deny", reason: expect.stringMatching(reason) });
    const noMail = plan({ tool: "remember", targets: [], documents: [] });
    expect(check(m, ask(), turn(noMail), ok("plan"), turn(m))).toEqual(deny(/the plan has no send_mail/));
    expect(check(m, ask(), turn(m))).toEqual(deny(/no plan was made/));
    expect(check({ ...m, screen: undefined }, ask(), turn(mailTom), turn(m))).toEqual(deny(/wasn't checked/));
    const outside = mail("m", ["x@evil.example"], { deny: "outside" });
    expect(check(outside, ask(), turn(mailTom), turn(outside))).toEqual(deny(/outside/));
  });

  it("holds a plan to its user message: a new message needs a new plan", () => {
    const m = mail("m", ["tom.whitfield@kestrelpay.example"]);
    expect(check(m, ask(), turn(mailTom), ok("plan"), ask("thanks"), turn(m))).toMatchObject({ kind: "deny" });
  });
});

describe("the policy in the loop", () => {
  it("runs before needsApproval: denied calls run as refusals, planned ones ask, planned remember just runs", () => {
    const planned = plan(
      { tool: "send_mail", targets: ["Tom"], documents: [] },
      { tool: "remember", targets: [], documents: [] },
    );
    const good = mail("good", ["tom.whitfield@kestrelpay.example"]);
    const bad = mail("bad", ["x@evil.example"], { deny: "outside the company" });
    const note: ToolCall = { callId: "note", tool: "remember", input: { note: "n" }, screen: {} };
    const events = log(ask(), turn(planned), ok("plan"), turn(good, bad, note));
    const action = decide(events, DEFAULT_CAPS, gate);
    expect(action).toMatchObject({ kind: "tools", calls: [{ callId: "bad", denied: expect.any(String) }, note] });

    events.push(...log(ok("bad"), ok("note")).map((e, i) => ({ ...e, seq: events.length + i + 1 })));
    expect(decide(events, DEFAULT_CAPS, gate)).toMatchObject({ kind: "approval", call: { callId: "good" } });
  });

  it("answers a denied call with its reason and runs nothing", async () => {
    sent.length = 0;
    const result = await runTool(
      { ...mail("bad", ["x@evil.example"]), denied: "Refused by policy: outside" } as ToolCall,
      { tools: TOOLS, viewer, runId: "run-1" },
    );
    expect(result).toEqual({ type: "tool_result", callId: "bad", ok: false, error: "Refused by policy: outside" });
    expect(sent).toEqual([]);
  });

  it("is off without the plan tool, so a tool set without it behaves as before", () => {
    const tools = TOOLS.filter((t) => t.name !== PLAN_TOOL);
    const m = mail("m", ["x@evil.example"], undefined as never);
    expect(decide(log(ask(), turn(m)), DEFAULT_CAPS, approvalNeeded(tools, viewer, "r"))).toMatchObject({
      kind: "approval",
    });
  });
});

describe("modelTurn", () => {
  it("forces make_plan on the turn after a user message, and records the guardrails' findings on writes", async () => {
    const { model, mock } = scriptedTurns([
      { toolCalls: [{ callId: "plan", name: PLAN_TOOL, input: { goal: "g", steps: [], writes: [] } }] },
      {
        toolCalls: [
          { callId: "m", name: "send_mail", input: { to: ["a@b.example"] } },
          { callId: "s", name: "search_documents", input: { query: "q" } },
        ],
      },
    ]);
    const screened: ToolCall[][] = [];
    const guard: RunGuard = {
      beforeModelTurn: async () => {},
      afterModelTurn: async () => {},
      beforeToolCall: async () => {},
      screen: async (calls) => {
        screened.push([...calls]);
        return calls.map(() => ({ deny: "outside" }));
      },
    };
    const deps = { model, tools: TOOLS, reasoningEffort: "low" as const, guard };
    await modelTurn({ instructions: "i", messages: [{ role: "user", content: "hi" }] }, deps);
    expect(mock.doStreamCalls[0].toolChoice).toEqual({ type: "tool", toolName: PLAN_TOOL });

    const second = await modelTurn(
      {
        instructions: "i",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "ok" },
        ],
      },
      deps,
    );
    expect(mock.doStreamCalls[1].toolChoice).not.toEqual({ type: "tool", toolName: PLAN_TOOL });
    expect(screened).toEqual([[expect.objectContaining({ callId: "m" })]]);
    expect(second.toolCalls).toEqual([
      expect.objectContaining({ callId: "m", screen: { deny: "outside" } }),
      expect.not.objectContaining({ screen: expect.anything() }),
    ]);
  });
});
