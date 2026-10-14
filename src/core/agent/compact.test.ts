// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { scriptedTurns } from "#learn/model/testing";

import type { AgentTool, RunEventData, ToolCall } from "./types";

import { DEFAULT_CAPS } from "./caps";
import { compact, keptFacts } from "./compact";
import { buildContext } from "./context";
import { approvalNeeded, decide, modelTurn } from "./loop";
import { inMemoryRun } from "./loop-testing";
import { PLAN_TOOL, planTool } from "./plan";

const viewer = { tenantId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222" };
const usage = { inputTokens: 100, outputTokens: 10, reasoningTokens: 0 };
const TOM = "Tom Whitfield <tom.whitfield@kestrelpay.example>";

const search: AgentTool<{ query: string }, unknown> = {
  name: "search_documents",
  description: "search",
  input: z.object({ query: z.string() }),
  effect: "read",
  needsApproval: () => false,
  execute: async () => ({}),
};
const sendMail: AgentTool<Record<string, unknown>, unknown> = {
  name: "send_mail",
  description: "mail",
  input: z.record(z.string(), z.unknown()),
  effect: "write",
  needsApproval: () => true,
  execute: async () => ({}),
};
const TOOLS = [planTool(), search, sendMail] as AgentTool[];

const writes = [
  { tool: "send_mail", targets: ["Tom Whitfield (tom.whitfield@kestrelpay.example)"], documents: [], note: null },
];
const planCall: ToolCall = { callId: "plan-1", tool: PLAN_TOOL, input: { goal: "Mail Tom", steps: [], writes } };

/** A long run: the user's message, the plan, then searches whose results are big enough to need compacting. */
function longRun() {
  const run = inMemoryRun();
  run.append(
    { type: "user_message", messageId: "m1", text: "Email Tom (tom.whitfield@kestrelpay.example) the Q3 revenue." },
    { type: "status", from: "queued", to: "running" },
    { type: "assistant_turn", text: "", toolCalls: [planCall], usage },
    { type: "tool_result", callId: "plan-1", ok: true, output: { planned: 1 } },
  );
  for (let i = 0; i < 8; i++) {
    const call: ToolCall = { callId: `s${i}`, tool: "search_documents", input: { query: `revenue ${i}` } };
    const passage = `Revenue rose in Q3 for line ${i}. `.repeat(250);
    run.append(
      { type: "assistant_turn", text: "", toolCalls: [call], usage },
      { type: "tool_result", callId: call.callId, ok: true, output: { passages: [{ text: passage }] } },
    );
  }
  return run;
}

describe("compaction and the plan", () => {
  it("keeps the plan in force verbatim in the kept facts, and says not to plan again", () => {
    const facts = keptFacts(longRun().events);
    expect(facts).toContain(
      `Plan in force for user message m1 (call plan-1; it's already made, so don't call ${PLAN_TOOL} again): ` +
        JSON.stringify(writes),
    );
  });

  it("leaves a plan made before an earlier message out: only the latest message's plan is in force", () => {
    const run = longRun();
    run.append({ type: "user_message", messageId: "m2", text: "Thanks." });
    expect(keptFacts(run.events)).not.toContain("Plan in force");
  });

  it("lets a long run make its planned write after compacting, without planning again", async () => {
    const run = longRun();
    const summary = await compact(run.events, {
      model: scriptedTurns([{ text: "The agent searched for Q3 revenue." }]).model,
      reasoningEffort: "low",
    });
    expect(summary).not.toBeNull();
    run.append(summary!);

    const context = buildContext(run.events);
    expect(JSON.stringify(context.messages[0])).toContain("Plan in force for user message m1");

    // The turn after compaction isn't a planning turn: make_plan isn't forced on the model.
    const mail: ToolCall = {
      callId: "mail-1",
      tool: "send_mail",
      input: { to: ["tom.whitfield@kestrelpay.example"], subject: "Q3", body: "Up.", attachmentDocumentIds: [] },
    };
    const { model, mock } = scriptedTurns([
      { toolCalls: [{ callId: mail.callId, name: mail.tool, input: mail.input }] },
    ]);
    const turn = await modelTurn(context, {
      model,
      tools: TOOLS,
      reasoningEffort: "low",
      guard: {
        beforeModelTurn: async () => {},
        afterModelTurn: async () => {},
        beforeToolCall: async () => {},
        screen: async (calls) => calls.map(() => ({ recipients: [TOM], documents: [] })),
      },
    });
    expect(mock.doStreamCalls[0].toolChoice).not.toEqual({ type: "tool", toolName: PLAN_TOOL });
    run.append(turn as RunEventData);

    // decide reads the plan from the whole log, compacted events included: the planned mail waits for its user.
    const next = decide(run.events, DEFAULT_CAPS, approvalNeeded(TOOLS, viewer, run.runId));
    expect(next).toMatchObject({ kind: "approval", call: { callId: "mail-1" } });
  });
});
