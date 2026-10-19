// @vitest-environment node
import { describe, expect, it } from "vitest";

import { drive, inMemoryRun } from "#learn/agent/loop-testing";
import { AGENT_INSTRUCTIONS } from "#learn/agent/prompt";

import { recordedRun, replayAgentModel, replayGuard, replayTools, RUN_NAMES } from "./loop-recorded";

describe("the recorded agent runs", () => {
  it.each(RUN_NAMES)("%s replays through the loop into the same events, sending the same requests", async (name) => {
    const recording = recordedRun(name);
    const { model, requests } = replayAgentModel(name);
    const run = inMemoryRun(recording.runId, Date.parse("2026-10-19T09:00:00Z"));
    run.append(recording.events[0].data);
    const last = await drive(run, {
      model,
      tools: replayTools(name),
      viewer: recording.viewer,
      instructions: AGENT_INSTRUCTIONS,
      reasoningEffort: "medium",
      guard: replayGuard(name),
      approve: () => "approved",
    });
    expect(last).toEqual(recording.outcome);
    expect(run.events.map((e) => e.data)).toEqual(recording.events.map((e) => e.data));
    // A change to the prompt, the context or a tool's schema shows here first: re-record then.
    expect(requests).toEqual(recording.turns.map((t) => t.request));
  });

  it("keeps the numbers the READMEs quote", () => {
    const usage = (name: (typeof RUN_NAMES)[number]) =>
      recordedRun(name).events.flatMap(({ data }) =>
        data.type === "assistant_turn" ? [[data.usage.inputTokens, data.usage.outputTokens]] : [],
      );
    expect(usage("kpc-terms")).toEqual([
      [1865, 105],
      [1949, 64],
      [4109, 62],
      [6532, 248],
      [6750, 28],
    ]);
    const kpc = recordedRun("kpc-terms");
    expect(kpc.tools.map((t) => [t.tool, t.endedMs - t.startedMs])).toEqual([
      ["make_plan", 0],
      ["search_documents", 5122],
      ["find_person", 7],
      ["read_document", 18],
      ["send_mail", 7],
    ]);
    expect(kpc.mail.map((m) => m.to)).toEqual([["tom.whitfield@kestrelpay.example"]]);
  });
});
