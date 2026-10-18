// @vitest-environment node
import { createUIMessageStream, type UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";

import type { ChatUIMessage } from "@/components/chat/types";

import { scriptedModel } from "#learn/model/testing";

import { answer } from "./answer";
import { writeAnswer, type StreamedAnswer } from "./stream";

const CHUNK = {
  id: "c1",
  documentId: "d1",
  title: "Expenses policy v2",
  path: "/HR/Policies/v2.pdf",
  text: "Meals while travelling are reimbursed up to £45 per day.",
  pageStart: 3,
  pageEnd: 3,
  section: null,
  score: 1,
};

async function written(text: string, chunks = [CHUNK]) {
  const streamed: StreamedAnswer = { sources: [], text: "", result: null };
  const stream = createUIMessageStream<ChatUIMessage>({
    execute: ({ writer }) =>
      writeAnswer(
        writer,
        answer({
          question: "q",
          retrieval: { query: "q", rewritten: [], chunks, auditId: "a" },
          model: scriptedModel(text).model,
          reasoningEffort: "medium",
        }),
        streamed,
      ),
  });
  const parts: UIMessageChunk[] = [];
  for await (const part of stream) parts.push(part);
  return { parts, streamed };
}

describe("writeAnswer", () => {
  it("writes the sources without their text, one text part, then the verdict", async () => {
    const { parts, streamed } = await written('Up to £45 [[S1: "reimbursed up to £45 per day"]].');
    const types = parts.map((p) => p.type).filter((t, i, all) => t !== "text-delta" || all[i - 1] !== "text-delta");
    expect(types).toEqual(["data-sources", "text-start", "text-delta", "text-end", "data-verdict"]);
    expect(JSON.stringify(parts[0])).not.toContain("reimbursed");
    expect(parts.at(-1)).toMatchObject({ data: { flagged: false, citations: [{ label: "S1" }] } });
    expect(streamed.text).toBe('Up to £45 [[S1: "reimbursed up to £45 per day"]].');
    expect(streamed.sources[0].text).toBe(CHUNK.text);
  });

  it("writes the abstention as the text when nothing was retrieved", async () => {
    const { parts } = await written("never", []);
    expect(parts.map((p) => p.type)).toEqual(["data-sources", "text-start", "text-delta", "text-end", "data-verdict"]);
    expect(parts.at(-1)).toMatchObject({ data: { abstained: true } });
  });
});
