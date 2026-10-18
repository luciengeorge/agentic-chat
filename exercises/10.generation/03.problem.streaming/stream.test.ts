// @vitest-environment node
import { createUIMessageStream, readUIMessageStream, type UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";

import type { CitableSource } from "#learn/cite/citations";
import type { AnswerEvent, AnswerResult } from "#learn/generate/answer";
import type { ChatUIMessage } from "@/components/chat/types";

import { answer } from "#learn/generate/answer";
import { writeAnswer, type StreamedAnswer } from "#learn/generate/stream";
import { APP_K, recordedTurn, replayModel } from "@/core/generate/recorded";

const SOURCE: CitableSource = {
  label: "S1",
  chunkId: "c1",
  documentId: "d1",
  title: "Travel and Expenses Policy v2.pdf",
  path: "/HR/Policies/Travel and Expenses Policy v2.pdf",
  pageStart: 2,
  pageEnd: 2,
  text: "| Hotel, London | £200 a night |",
};

const RESULT: AnswerResult = {
  text: "£200 a night.",
  report: { citations: [], dropped: [], flagged: true },
  abstained: false,
  flagged: true,
  finishReason: "stop",
  usage: null,
};

async function* script(...events: AnswerEvent[]): AsyncGenerator<AnswerEvent> {
  for (const event of events) yield event;
}

const fresh = (): StreamedAnswer => ({ sources: [], text: "", result: null });

function stream(events: AsyncIterable<AnswerEvent>, streamed = fresh()) {
  return createUIMessageStream<ChatUIMessage>({
    execute: ({ writer }) => writeAnswer(writer, events, streamed),
    onError: (error) => String(error),
  });
}

async function parts(events: AsyncIterable<AnswerEvent>, streamed = fresh()) {
  const out: UIMessageChunk[] = [];
  for await (const part of stream(events, streamed)) out.push(part);
  return out;
}

describe("writing the answer to the UI message stream", () => {
  it("writes the sources, one text part, then the verdict", async () => {
    const out = await parts(
      script(
        { type: "sources", sources: [SOURCE] },
        { type: "text-delta", delta: "£200 " },
        { type: "text-delta", delta: "a night." },
        { type: "done", result: RESULT },
      ),
    );
    expect(
      out.map((p) => p.type),
      "one text-start before the first delta, one text-end before the verdict",
    ).toEqual(["data-sources", "text-start", "text-delta", "text-delta", "text-end", "data-verdict"]);
    expect(out.filter((p) => "id" in p && p.type.startsWith("text")).map((p) => (p as { id: string }).id)).toEqual(
      Array(4).fill("text"),
    );
    expect(out.at(-1)).toEqual({
      type: "data-verdict",
      id: "verdict",
      data: { citations: [], dropped: [], abstained: false, flagged: true },
    });
  });

  it("sends the browser each source without its text, and keeps the text in streamed", async () => {
    const streamed = fresh();
    const [first] = await parts(
      script({ type: "sources", sources: [SOURCE] }, { type: "done", result: RESULT }),
      streamed,
    );
    expect(first, "a chunk's text stays on the server: send sourceRef(source)").toEqual({
      type: "data-sources",
      id: "sources",
      data: { sources: [{ ...SOURCE, text: undefined }].map(({ text: _t, ...ref }) => ref) },
    });
    expect(streamed.sources, "keep the full sources (with text) for the validator").toEqual([SOURCE]);
  });

  it("writes no text part when the model said nothing", async () => {
    const out = await parts(script({ type: "sources", sources: [SOURCE] }, { type: "done", result: RESULT }));
    expect(
      out.map((p) => p.type),
      "text-end only closes a text part that was started",
    ).toEqual(["data-sources", "data-verdict"]);
  });

  it("writes each delta before the model has sent the next", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    async function* slow(): AsyncGenerator<AnswerEvent> {
      yield { type: "sources", sources: [SOURCE] };
      yield { type: "text-delta", delta: "£200" };
      await gate;
      yield { type: "text-delta", delta: " a night." };
      yield { type: "done", result: RESULT };
    }
    const reader = stream(slow()).getReader();
    const seen: string[] = [];
    const firstDelta = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return false;
        seen.push(value.type);
        if (value.type === "text-delta") return true;
      }
    })();
    const timeout = new Promise<false>((resolve) => setTimeout(() => resolve(false), 500));
    expect(
      await Promise.race([firstDelta, timeout]),
      "the first delta never reached the stream while the model was still writing: write each one as it comes",
    ).toBe(true);
    release();
    while (!(await reader.read()).done);
  });

  it("keeps streamed up to date, so a stopped answer still has what was sent", async () => {
    const streamed = fresh();
    async function* stopped(): AsyncGenerator<AnswerEvent> {
      yield { type: "sources", sources: [SOURCE] };
      yield { type: "text-delta", delta: "£200 " };
      yield { type: "text-delta", delta: "a" };
      throw new DOMException("Leo closed the tab", "AbortError");
    }
    const out = await parts(stopped(), streamed);
    expect(out.map((p) => p.type)).toEqual(["data-sources", "text-start", "text-delta", "text-delta", "error"]);
    expect(streamed, "add each delta to streamed.text as you write it").toEqual({
      sources: [SOURCE],
      text: "£200 a",
      result: null,
    });
  });
});

describe("Leo's London hotel answer", () => {
  it("arrives as 8 sources, 61 deltas of text and two citations of S3", async () => {
    const leo = recordedTurn("london-hotel");
    const events = answer({
      question: leo.question,
      retrieval: { query: leo.question, rewritten: [], chunks: leo.chunks.slice(0, APP_K), auditId: "a" },
      model: replayModel("london-hotel").model,
      reasoningEffort: "medium",
    });
    const streamed = fresh();
    const ui = createUIMessageStream<ChatUIMessage>({
      execute: async ({ writer }) => {
        writer.write({ type: "start", messageId: "reply-1" });
        await writeAnswer(writer, events, streamed);
        writer.write({ type: "finish", finishReason: "stop" });
      },
    });
    const [forCount, forChat] = ui.tee();
    let deltas = 0;
    for await (const part of forCount) if (part.type === "text-delta") deltas += 1;
    let message: ChatUIMessage | undefined;
    for await (const m of readUIMessageStream<ChatUIMessage>({ stream: forChat })) message = m;

    expect(deltas).toBe(61);
    expect(
      message!.parts.map((p) => p.type),
      "what useChat builds: sources, one text, the verdict",
    ).toEqual(["data-sources", "text", "data-verdict"]);
    const [sources, text, verdict] = message!.parts;
    expect(sources.type === "data-sources" && sources.data.sources.map((s) => s.label)).toEqual([
      "S1",
      "S2",
      "S3",
      "S4",
      "S5",
      "S6",
      "S7",
      "S8",
    ]);
    expect(sources.type === "data-sources" && sources.data.sources[0].title).toBe("Travel and Expenses Policy.pdf");
    expect(text.type === "text" && text.text).toMatch(
      /^The v2 policy sets the London hotel limit at \*\*£200 per night\*\*/,
    );
    expect(verdict.type === "data-verdict" && verdict.data.citations.map((c) => c.quote)).toEqual([
      "£180 a night | £200 a night",
      "Version 2.0 (from 1 July 2026)",
    ]);
    expect(streamed.text).toBe(text.type === "text" && text.text);
  });
});
