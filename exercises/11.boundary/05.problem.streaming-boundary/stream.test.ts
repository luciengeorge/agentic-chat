// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { HEARTBEAT_MS, withHeartbeat } from "#learn/boundary/stream";
import { APP_K, recordedReply, recordedTurn, replayModel } from "@/core/generate/recorded";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";
import { handleChat } from "@/routes/api/chat/-chat";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const HEARTBEAT = ": heartbeat\n\n";
const EVENTS = ['data: {"type":"start"}\n\n', 'data: {"type":"text-delta","delta":"£200"}\n\n', "data: [DONE]\n\n"];

/** A body that hands over each chunk after `waitMs`, and remembers whether it was cancelled. */
function source(chunks: string[], waitMs = 0) {
  const state = { cancelled: null as unknown, pulls: 0 };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      state.pulls += 1;
      if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
      const next = chunks.shift();
      if (next === undefined) controller.close();
      else controller.enqueue(encode(next));
    },
    cancel(reason) {
      state.cancelled = reason ?? "cancelled";
    },
  });
  return { body, state };
}

async function readAll(stream: ReadableStream<Uint8Array>) {
  const out: string[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return out;
    out.push(decode(value));
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("withHeartbeat", () => {
  it("passes every chunk through whole and in order, then closes", async () => {
    const { body } = source([...EVENTS]);
    expect(await readAll(withHeartbeat(body, 60_000, () => {})), "the same chunks, untouched").toEqual(EVENTS);
  });

  it("sends a comment every interval while the body is quiet, between whole events", async () => {
    const { body } = source([...EVENTS], 40);
    const out = await readAll(withHeartbeat(body, 15, () => {}));
    expect(
      out.filter((chunk) => chunk !== HEARTBEAT),
      "heartbeats go between chunks, never inside one",
    ).toEqual(EVENTS);
    expect(out.filter((chunk) => chunk === HEARTBEAT).length, "a quiet 120 ms at 15 ms a beat").toBeGreaterThan(2);
    expect(HEARTBEAT.startsWith(":"), "an SSE line starting with ':' is a comment every reader skips").toBe(true);
  });

  it("stops the heartbeat when the body ends", async () => {
    vi.useFakeTimers();
    const { body } = source([...EVENTS]);
    const stream = withHeartbeat(body, 1000, () => {});
    const reading = readAll(stream);
    await vi.advanceTimersByTimeAsync(10);
    await reading;
    expect(vi.getTimerCount(), "clear the interval when the body is done, or it ticks on forever").toBe(0);
  });

  it("passes an upstream error on, and stops the heartbeat", async () => {
    vi.useFakeTimers();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("the model call failed"));
      },
    });
    const error = await readAll(withHeartbeat(body, 1000, () => {})).catch((e: unknown) => e);
    expect(error, "error the stream with the body's error").toMatchObject({ message: "the model call failed" });
    expect(vi.getTimerCount(), "and clear the interval").toBe(0);
  });

  it("calls onCancel once and cancels the body when the reader goes away", async () => {
    vi.useFakeTimers();
    const { body, state } = source([...EVENTS], 5000);
    let cancelled = 0;
    const reader = withHeartbeat(body, 1000, () => (cancelled += 1)).getReader();
    void reader.read();
    await reader.cancel("Leo closed the tab");
    expect(cancelled, "the cancel must call onCancel: that's what aborts the model").toBe(1);
    expect(state.cancelled, "cancel the body you were reading, with the reason").toBe("Leo closed the tab");
    expect(vi.getTimerCount() <= 1, "no heartbeat after the reader left").toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a 40-second silence open with heartbeats at 15 and 30 seconds", async () => {
    vi.useFakeTimers();
    expect(HEARTBEAT_MS).toBe(15_000);
    let waited = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (waited) return controller.close();
        await new Promise((resolve) => setTimeout(resolve, 40_000));
        waited = true;
        controller.enqueue(encode(EVENTS[1]));
      },
    });
    const reading = readAll(withHeartbeat(body, HEARTBEAT_MS, () => {}));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await reading, 'the heartbeat is the comment ": heartbeat\\n\\n", which every reader skips').toEqual([
      HEARTBEAT,
      HEARTBEAT,
      EVENTS[1],
    ]);
  });
});

describe.skipIf(!postgresAvailable)("Leo closes the tab on his London answer", () => {
  let t: TestDatabase;
  let kestrel: string;
  const leo = "44444444-4444-4444-8444-444444444444";

  beforeAll(async () => {
    t = await createTestDatabase();
    [{ id: kestrel }] = await t.sql`
      INSERT INTO organization (name, slug, created_at) VALUES ('Kestrel Pay', 'kestrel', now()) RETURNING id`;
    await t.sql`INSERT INTO principals (id, tenant_id, kind, external_id, name, display_name, enabled, synced_at)
                VALUES (${leo}, ${kestrel}, 'user', ${leo}, 'leo.martin', 'Leo Martin', true, now())`;
  });

  afterAll(async () => {
    await t?.drop();
  });

  it("aborts the model call and stores the part he saw, marked stopped", async () => {
    const turn = recordedTurn("london-hotel");
    expect(new TextEncoder().encode(turn.sse).byteLength, "the recorded reply's bytes, 512 at a time").toBe(56_339);
    const replay = replayModel("london-hotel", { readSize: 512, delayMs: 10 });
    const conversation = crypto.randomUUID();
    const response = await handleChat(
      new Request("http://localhost:3000/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: conversation,
          message: { id: "leo-1", role: "user", parts: [{ type: "text", text: turn.question }] },
        }),
      }),
      { tenantId: kestrel, userId: leo },
      {
        db: t.appDb,
        retrieve: async (_viewer, query) => ({
          query,
          rewritten: [],
          chunks: turn.chunks.slice(0, APP_K),
          auditId: "a",
        }),
        model: replay.model,
        reasoningEffort: "medium",
        bucket: { name: "chat", capacity: 10, refillPerSecond: 10 / 60 },
      },
    );
    const reader = response.body!.getReader();
    let seen = "";
    while (!seen.includes('"text-delta"')) seen += decode((await reader.read()).value!);
    await reader.cancel();

    const stored = () =>
      t.sql`SELECT content FROM messages WHERE conversation_id = ${conversation} AND role = 'assistant'`;
    await expect
      .poll(async () => (await stored())[0]?.content.status, {
        timeout: 3000,
        message: "the reply was stored as finished: the model kept going after Leo left. Call onCancel in cancel",
      })
      .toBe("aborted");
    const [{ content }] = await stored();
    const full = recordedReply("london-hotel");
    expect(content.text.length, "only what was sent before the tab closed").toBeLessThan(full.length);
    expect(full.startsWith(content.text)).toBe(true);
    expect(replay.requests).toHaveLength(1);
  });
});
