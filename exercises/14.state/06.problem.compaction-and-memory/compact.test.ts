// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { RunEvent, RunEventData } from "#learn/agent/types";

import { compact, compactionPoint, eventTokens, keptFacts, liveEvents, planInForce } from "#learn/agent/compact";
import { buildContext, messageTokens } from "#learn/agent/context";
import { scriptedModel } from "#learn/model/testing";
import { recordedEvents } from "@/core/agent/state-testing";

const tokens = (events: readonly RunEvent[]) => events.reduce((sum, e) => sum + eventTokens(e), 0);
const lostPlan = recordedEvents("lost-plan", 16);
const PLAN = `Plan in force for user message smoke-c600f552 (call call_4OPecZV5y1VLYzaMC6mmEfYO; it's already made, so don't call make_plan again): [{"tool":"send_mail","targets":["Daniel Reyes (daniel.reyes@kestrelpay.example)"],"documents":[]}]`;
const FOLLOW_UP: RunEventData = { type: "user_message", messageId: "follow-up", text: "Actually, send it to Amara." };

describe("where to cut", () => {
  it("doesn't cut a log at or under the threshold", () => {
    const kpc = recordedEvents("kpc-email");
    expect(tokens(liveEvents(kpc))).toBe(5_686);
    expect(compactionPoint(kpc), "Leo's run is 5,686 tokens, under 16,000").toBeNull();
  });

  it("cuts where every call has its answer, never between a call and its result", () => {
    // Keep exactly what's after seq 13: seq 13 would qualify by size, but its read_document call has no result
    // until seq 14.
    const keep = tokens(lostPlan.filter((e) => e.seq > 13));
    expect(
      compactionPoint(lostPlan, { thresholdTokens: 16_000, keepTokens: keep }),
      "seq 13 is a call waiting for its result (seq 14): the latest closed point leaving that much is 12",
    ).toBe(12);
  });

  it("never cuts past an open approval, and counts a refusal as an answer", () => {
    const small = { thresholdTokens: 100, keepTokens: 0 };
    expect(
      compactionPoint(recordedEvents("kpc-email", 12), small),
      "seq 10 calls send_mail, and 11 only asks for approval: the call is open until it's decided, so cut at 9",
    ).toBe(9);
    expect(
      compactionPoint(recordedEvents("cancel-waiting"), small),
      "the approval was rejected at seq 10: a refused write is answered, so the log is closed again",
    ).toBe(11);
  });

  it("counts only the events after the latest compaction", () => {
    const two = recordedEvents("two-compactions");
    const sinceFirst = two.filter((e) => e.seq <= 19);
    expect(tokens(liveEvents(sinceFirst))).toBe(11_733);
    expect(
      compactionPoint(sinceFirst),
      "seq 12 to 19 are 11,733 tokens: what the first compaction covers is a summary already, don't count it again",
    ).toBeNull();
    expect(compactionPoint(two.filter((e) => e.seq <= 22)), "19,417 live tokens at seq 22: the second cut").toBe(18);
  });
});

describe("the plan in force", () => {
  it("is the user's latest message's make_plan call, copied word for word", () => {
    expect(
      planInForce(recordedEvents("lost-plan", 12)),
      "the line, exactly: the message id, the call id, and the writes as JSON.stringify gives them",
    ).toBe(PLAN);
  });

  it("isn't a make_plan the policy refused in a later turn", () => {
    // Seq 18 is the model planning again after the bad summary; seq 19 is the policy's refusal.
    expect(
      planInForce(recordedEvents("lost-plan", 19)),
      "only a plan made in the first turn after the user's message is in force (isPlanningCall)",
    ).toBe(PLAN);
  });

  it("is gone once the user sends a new message that hasn't been planned yet", () => {
    const events = recordedEvents("lost-plan", 12);
    const followUp = [...events, { ...events[0], seq: 13, data: FOLLOW_UP }];
    expect(planInForce(followUp), "a plan covers the message it was made for, not the next one").toBeNull();
  });

  it("comes from the log, not the context window: still there at the second compaction", () => {
    // The first compaction (seq 16) covered seq 1 to 11, the plan included; the second cuts at 18.
    const events = recordedEvents("two-compactions", 18);
    const line = planInForce(events) ?? "(null)";
    expect(
      line,
      "the plan was made at seq 3, inside the first summary's span: look for it in every event, not just the live ones",
    ).toContain("call call_xl73Y8BZFik6rzZ5ibJ1lGg9");
    expect(line).toContain('"targets":["Tom Whitfield (tom.whitfield@kestrelpay.example)"]');
  });
});

describe("the worked example: the lost-plan run, compacted again", () => {
  it("cuts 16,285 tokens at seq 12, keeps the plan verbatim, and shrinks the context to 5,700 tokens", async () => {
    expect(tokens(liveEvents(lostPlan)), "16,285 tokens of live events at seq 16: past 16,000").toBe(16_285);
    expect(compactionPoint(lostPlan), "after seq 14, only 3,575 tokens would stay: under the 4,000 kept").toBe(12);

    // The summary the model really wrote on 14 October, without the facts code added to it then.
    const recorded = recordedEvents("lost-plan", 17).at(-1)!.data;
    if (recorded.type !== "compaction") throw new Error("seq 17 should be the compaction");
    const story = recorded.summary.split("\n\nTool calls:")[0];
    expect(recorded.summary, "the summary that lost the plan").not.toContain("Plan in force");

    const compaction = await compact(lostPlan, { model: scriptedModel(story).model, reasoningEffort: "low" });
    expect(compaction?.throughSeq).toBe(12);
    expect(compaction?.summary.split("\n\n")[1]?.split("\n")[0], "the kept facts start with the plan").toBe(PLAN);
    expect(keptFacts(recordedEvents("lost-plan", 12)).startsWith(PLAN)).toBe(true);

    const after = buildContext([...lostPlan, { ...lostPlan[0], seq: 17, data: compaction! }]);
    expect(after.messages).toHaveLength(5);
    expect(
      after.messages.reduce((sum, m) => sum + messageTokens(m), 0),
      "15,675 tokens before; 5,630 with the summary that lost the plan; 5,700 with it",
    ).toBe(5_700);
    expect(after.planning, "a summary isn't a user message: no new plan is asked for").toBeUndefined();
  });
});
