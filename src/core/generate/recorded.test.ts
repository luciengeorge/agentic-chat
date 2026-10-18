// @vitest-environment node
import { describe, expect, it } from "vitest";

import { CHAT_REASONING_EFFORT } from "#learn/model/config";

import { answer, type AnswerResult } from "./answer";
import { APP_K, recordedReply, recordedTurn, replayModel, TURN_NAMES, type TurnName } from "./recorded";

async function replay(name: TurnName) {
  const turn = recordedTurn(name);
  const { model, requests } = replayModel(name);
  let result: AnswerResult | null = null;
  for await (const event of answer({
    question: turn.question,
    retrieval: { query: turn.question, rewritten: turn.rewritten, chunks: turn.chunks.slice(0, APP_K), auditId: "a" },
    model,
    reasoningEffort: CHAT_REASONING_EFFORT,
    maxOutputTokens: 2000,
  })) {
    if (event.type === "done") result = event.result;
  }
  return { turn, result: result!, requests };
}

describe("the recorded chat turns", () => {
  it("each holds 30 chunks and the reply to the first 8", () => {
    for (const name of TURN_NAMES) expect(recordedTurn(name).chunks, name).toHaveLength(30);
  });

  it("rebuild the request that was recorded, so the prompt hasn't changed since", async () => {
    for (const name of TURN_NAMES) {
      const { turn, requests } = await replay(name);
      expect(requests, name).toEqual([turn.request]);
    }
  });

  it("give the verdicts they gave when they were recorded", async () => {
    const verdicts = Object.fromEntries(
      await Promise.all(
        TURN_NAMES.map(async (name) => {
          const { result } = await replay(name);
          return [
            name,
            {
              abstained: result.abstained,
              flagged: result.flagged,
              kept: result.report.citations.map((c) => c.label),
              dropped: result.report.dropped.map((d) => `${d.label} ${d.reason}`),
            },
          ];
        }),
      ),
    );
    expect(verdicts).toEqual({
      "london-hotel": { abstained: false, flagged: false, kept: ["S3", "S3"], dropped: [] },
      heron: { abstained: true, flagged: false, kept: [], dropped: [] },
      brightwell: { abstained: false, flagged: false, kept: ["S1", "S3"], dropped: [] },
      "invoice-hold": { abstained: false, flagged: true, kept: ["S1", "S1"], dropped: ["S1 quote-not-found"] },
    });
  });
});

describe("recordedReply", () => {
  it("reads the reply's text from the recorded events", async () => {
    for (const name of TURN_NAMES) expect(recordedReply(name), name).toBe((await replay(name)).result.text);
  });
});
