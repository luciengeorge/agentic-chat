import { describe, expect, it } from "vitest";

import { promptText, scriptedTurns } from "#learn/model/testing";

import { ROUTE_TOOL, routeMessage } from "./router";

const routed = (route: string, reason = "because") =>
  scriptedTurns([{ toolCalls: [{ callId: "r1", name: ROUTE_TOOL, input: { route, reason } }] }]);

describe("routeMessage", () => {
  it("sends a question to a plain answer", async () => {
    const { model, mock } = routed("answer", "a policy question");
    const decision = await routeMessage(
      { message: "What's the daily meal allowance?", liveRun: false },
      { model, reasoningEffort: "low" },
    );
    expect(decision).toMatchObject({ route: "answer", reason: "a policy question" });
    expect(decision.usage?.inputTokens).toBe(100);
    const call = mock.doStreamCalls[0];
    expect(call.toolChoice).toEqual({ type: "tool", toolName: ROUTE_TOOL });
    expect(promptText(mock)).toContain("Live agent run in this conversation: no");
  });

  it("sends a request to act to an agent run", async () => {
    const { model } = routed("agent", "it asks to send an email");
    const decision = await routeMessage(
      { message: "Email Tom the payment terms of KPC-2026-0142", liveRun: false },
      { model, reasoningEffort: "low" },
    );
    expect(decision.route).toBe("agent");
  });

  it("tells the model when a run is live, so a follow-up can go into it", async () => {
    const { model, mock } = routed("agent", "it carries on the live run");
    const decision = await routeMessage(
      { message: "send it to Amara instead", liveRun: true },
      { model, reasoningEffort: "low" },
    );
    expect(decision.route).toBe("agent");
    expect(promptText(mock)).toContain("Live agent run in this conversation: yes");
    expect(promptText(mock)).toContain("<message>\nsend it to Amara instead\n</message>");
  });

  it("falls back to a plain answer when the model's choice isn't valid", async () => {
    const { model } = routed("maybe");
    expect((await routeMessage({ message: "hm", liveRun: false }, { model, reasoningEffort: "low" })).route).toBe(
      "answer",
    );
    const { model: silent } = scriptedTurns([{ text: "I think agent" }]);
    expect(
      await routeMessage({ message: "hm", liveRun: false }, { model: silent, reasoningEffort: "low" }),
    ).toMatchObject({ route: "answer", reason: expect.stringContaining("the router failed") });
  });
});
