// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import type { ExRunner, TestEvent } from "./workshop-server";

import { readTestEvents } from "./test-run";
import { testEventStream } from "./workshop-server";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("the test stream", () => {
  it("reads events split across chunks, characters included, and skips heartbeats", async () => {
    const text = `: keep-alive\n\ndata: {"type":"started","step":"04.1","target":"problem"}\n\ndata: {"type":"collected","nodeids":["a > café 🐨"]}\n\n`;
    const all = bytes(text);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < all.length; i += 7) controller.enqueue(all.slice(i, i + 7));
        controller.close();
      },
    });
    const events: TestEvent[] = [];
    await readTestEvents(stream, (event) => events.push(event));
    expect(events).toEqual([
      { type: "started", step: "04.1", target: "problem" },
      { type: "collected", nodeids: ["a > café 🐨"] },
    ]);
  });

  it("sends ex's events as they come, a heartbeat while it's quiet, then the run", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const run: ExRunner = async (args, options) => {
      expect(args).toEqual(["test", "04.1", "--target", "solution", "--progress"]);
      options?.onStderrLine?.("not json: pnpm talking");
      options?.onStderrLine?.(JSON.stringify({ event: "collected", nodeids: ["t > one"] }));
      await new Promise<void>((done) => (finish = done));
      return { code: 0, json: { step: "04.1", target: "solution", passed: true, tests: [], warnings: [] } };
    };
    const stream = testEventStream(run, {
      step: "04.1",
      target: "solution",
      signal: new AbortController().signal,
      heartbeatMs: 1000,
    });
    const bytesReader = stream.getReader();
    const decoder = new TextDecoder();
    const reader = {
      read: async () => {
        const { value, done } = await bytesReader.read();
        return { done, value: value && decoder.decode(value) };
      },
    };
    expect((await reader.read()).value).toBe('data: {"type":"started","step":"04.1","target":"solution"}\n\n');
    expect((await reader.read()).value).toBe('data: {"type":"collected","nodeids":["t > one"]}\n\n');
    await vi.advanceTimersByTimeAsync(1000);
    expect((await reader.read()).value).toBe(": keep-alive\n\n");
    finish();
    vi.useRealTimers();
    expect((await reader.read()).value).toContain('"type":"done"');
    expect((await reader.read()).done).toBe(true);
  });

  it("aborts ex when the client cancels the stream", async () => {
    let signal: AbortSignal | undefined;
    const run: ExRunner = (_, options) =>
      new Promise((resolve) => {
        signal = options?.signal;
        signal?.addEventListener("abort", () => resolve({ code: 1, json: {} }));
      });
    const stream = testEventStream(run, { step: "04.2", target: "problem", signal: new AbortController().signal });
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    expect(signal?.aborted).toBe(true);
  });
});
