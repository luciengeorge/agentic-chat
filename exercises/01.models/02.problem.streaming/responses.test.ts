// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { ChatEvent } from "#learn/model/types";

import { buildPrompt } from "#learn/generate/prompt";
import { parseSse, responsesChatModel, type SseEvent } from "#learn/model/responses";
import { CASSETTE_QUESTION, CASSETTE_SOURCES, cassette, cassetteFetch } from "@/core/model/cassette";

const encode = (text: string) => new TextEncoder().encode(text);
const ANSWER = encode(cassette("answer").body);

/** A body that hands over `bytes` in reads cut at the given offsets. */
function cutAt(bytes: Uint8Array, offsets: number[]): ReadableStream<Uint8Array> {
  const edges = [0, ...offsets, bytes.length];
  const reads = edges.slice(1).map((end, i) => bytes.slice(edges[i], end));
  return new ReadableStream({
    pull(controller) {
      const next = reads.shift();
      if (next) controller.enqueue(next);
      else controller.close();
    },
  });
}

/** Offsets every `size` bytes. */
const every = (bytes: Uint8Array, size: number) =>
  Array.from({ length: Math.ceil(bytes.length / size) - 1 }, (_, i) => (i + 1) * size);

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

const sse = (bytes: Uint8Array, offsets: number[] = []) => collect(parseSse(cutAt(bytes, offsets)));
const json = (event: SseEvent) => JSON.parse(event.data) as { type: string; delta?: string };

describe("reading server-sent events", () => {
  it("gives the recorded answer's 64 events, however the reads cut its bytes", async () => {
    const whole = await sse(ANSWER);
    expect(whole, "one read of all 28,955 bytes").toHaveLength(64);
    expect(whole[0]).toMatchObject({ event: "response.created" });
    expect(whole.at(-1)).toMatchObject({ event: "response.completed" });
    for (const size of [1024, 7, 1]) {
      expect(
        await sse(ANSWER, every(ANSWER, size)),
        `read ${size} bytes at a time: an event cut across two reads waits in the buffer`,
      ).toEqual(whole);
    }
  });

  it("keeps a £ whole when a read ends between its two bytes", async () => {
    // Event 13 is the delta "£". Its two bytes, C2 A3, sit at offsets 10,272 and 10,273.
    expect([ANSWER[10272], ANSWER[10273]]).toEqual([0xc2, 0xa3]);
    const events = await sse(ANSWER, [10273]);
    expect(events).toHaveLength(64);
    expect(
      json(events[12]),
      "decode with one TextDecoder and { stream: true }, or the £ comes out as two �",
    ).toMatchObject({
      type: "response.output_text.delta",
      delta: "£",
    });
    expect(events.some((e) => e.data.includes("�"))).toBe(false);
  });

  it("joins an event's data lines with a newline, and skips comment lines", async () => {
    const text = ': keep-alive\n\nevent: a\ndata: {"x":\ndata: 1}\n\n: ping\n\n';
    expect(await sse(encode(text), every(encode(text), 3))).toEqual([{ event: "a", data: '{"x":\n1}' }]);
  });

  it("reads CRLF as one line break, even when a read ends between the CR and the LF", async () => {
    const text = "event: a\r\ndata: 1\r\ndata: 2\r\n\r\nevent: b\r\ndata: 3\r\n\r\n";
    const expected = [
      { event: "a", data: "1\n2" },
      { event: "b", data: "3" },
    ];
    expect(await sse(encode(text))).toEqual(expected);
    const afterCr = text.indexOf("1\r") + 2;
    expect(
      await sse(encode(text), [afterCr]),
      "a CR at the end of a read may be half a CRLF: wait for the next read",
    ).toEqual(expected);
  });

  it("yields the last event even when no blank line follows it", async () => {
    expect(
      await sse(encode("event: a\ndata: 1\n\nevent: b\ndata: 2")),
      "when the reads are done, what's left in the buffer is one more event",
    ).toEqual([
      { event: "a", data: "1" },
      { event: "b", data: "2" },
    ]);
  });

  it("streams the recorded answer read 1,024 bytes at a time: 29 reads, 54 deltas, then the bill", async () => {
    const offsets = every(ANSWER, 1024);
    expect(offsets.length + 1).toBe(29);
    const starts = (await sse(ANSWER)).reduce<number[]>((acc, e) => {
      const at = acc.length ? acc.at(-1)! : 0;
      return [...acc, at + encode(`event: ${e.event}\ndata: ${e.data}\n\n`).length];
    }, []);
    const cut = starts.filter((end, i) => Math.floor((i ? starts[i - 1] : 0) / 1024) !== Math.floor((end - 1) / 1024));
    expect(cut.length, "events that straddle two reads").toBe(21);

    const recorded = cassette("answer").request as { input: Array<{ content: string }> };
    const prompt = buildPrompt({ question: CASSETTE_QUESTION, chunks: CASSETTE_SOURCES });
    expect(prompt.messages[0].content).toBe(recorded.input[0].content);
    const { fetch } = cassetteFetch(["answer"], { readSize: 1024 });
    const events: ChatEvent[] = await collect(
      responsesChatModel({ model: "gpt-6-luna", apiKey: "sk-replay", fetch }).stream({
        instructions: prompt.instructions,
        messages: prompt.messages,
        reasoningEffort: "medium",
      }),
    );
    const deltas = events.flatMap((e) => (e.type === "text-delta" ? [e.delta] : []));
    expect(deltas).toHaveLength(54);
    expect(deltas.join("")).toBe(
      'The London hotel limit is **£200 a night** under v2. [[S1: "Hotel, London | £200 a night"]] The older version lists **£180 a night**. [[S2: "Hotel, London | £180 a night"]]',
    );
    expect(events.at(-1)).toEqual({
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: 598, outputTokens: 113, reasoningTokens: 53 },
    });
  });
});
