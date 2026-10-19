// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { AgentTool, ToolContext } from "#learn/agent/types";

import { stepIdempotencyKey, withIdempotencyKey } from "#learn/agent/durable";

const RUN = "067c2097-4255-43c5-8abd-293999f6d877";
const STEP = "step_01M59S7YTACRNRD7B4V4Z4QEPV";

const tool = (name: string, effect: "read" | "write"): AgentTool => ({
  name,
  description: name,
  input: z.object({}),
  effect,
  needsApproval: () => effect === "write",
  execute: vi.fn(async () => ({ ok: name })),
});
const ctx: ToolContext = {
  viewer: { tenantId: "t", userId: "u" },
  runId: RUN,
  callId: "call_4NmkEZ5nioB2ceFw1vL09fLI",
  idempotencyKey: `agent:${RUN}:call_4NmkEZ5nioB2ceFw1vL09fLI`,
  signal: new AbortController().signal,
};

describe("stepIdempotencyKey", () => {
  it("names the run and the step: agent:<run>:<step>", () => {
    expect(stepIdempotencyKey(RUN, STEP)).toBe(`agent:${RUN}:${STEP}`);
  });

  it("gives the same key however often it's asked, so a retried step sends the key it sent first", () => {
    const keys = new Set(Array.from({ length: 5 }, () => stepIdempotencyKey(RUN, STEP)));
    expect(keys.size, "a key that changes between calls is a new mail on every retry: build it from the ids only").toBe(
      1,
    );
  });

  it("gives another step, or another run, another key", () => {
    const keys = new Set([
      stepIdempotencyKey(RUN, STEP),
      stepIdempotencyKey(RUN, "step_01M59S7YTACRNRD7B4V4Z4QEPW"),
      stepIdempotencyKey("e6a8f75d-dde9-4a79-a75e-a6b7d723f7ea", STEP),
    ]);
    expect(keys.size).toBe(3);
  });
});

describe("withIdempotencyKey", () => {
  it("hands every tool the step's key in place of the loop's, and the rest of the context as it was", async () => {
    const mail = tool("send_mail", "write");
    const search = tool("search_documents", "read");
    const key = stepIdempotencyKey(RUN, STEP);
    const wrapped = withIdempotencyKey([mail, search], key);
    expect(wrapped.map((t) => t.name)).toEqual(["send_mail", "search_documents"]);
    expect(await wrapped[0].execute({ to: "tom" }, ctx)).toEqual({ ok: "send_mail" });
    await wrapped[1].execute({}, ctx);
    expect(mail.execute).toHaveBeenCalledWith({ to: "tom" }, { ...ctx, idempotencyKey: key });
    expect(search.execute).toHaveBeenCalledWith({}, { ...ctx, idempotencyKey: key });
    expect(wrapped[0].effect).toBe("write");
    expect(wrapped[0].needsApproval({}, ctx)).toBe(true);
  });

  it("leaves the tools it was given alone: other runs still use the loop's key", async () => {
    const mail = tool("send_mail", "write");
    const execute = mail.execute;
    withIdempotencyKey([mail], stepIdempotencyKey(RUN, STEP));
    expect(mail.execute, "the original tool was changed in place; copy it instead").toBe(execute);
    await mail.execute({}, ctx);
    expect(execute).toHaveBeenCalledWith({}, ctx);
  });
});
