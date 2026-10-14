import { describe, expect, it } from "vitest";
import { z } from "zod";

import { scriptedTurns } from "#learn/model/testing";

import type { AgentTool, RunEventData } from "./types";

import { DEFAULT_CAPS } from "./caps";
import { drive, inMemoryRun } from "./loop-testing";
import { childCaps, childOutcome, childRunId, delegateTool, type RunChild } from "./orchestrate";

const viewer = { tenantId: "t1", userId: "u1" };

const readDoc: AgentTool = {
  name: "read_document",
  description: "read",
  input: z.object({ documentId: z.string() }),
  effect: "read",
  needsApproval: () => false,
  execute: async ({ documentId }: { documentId: string }) => ({
    text: documentId === "v1" ? "Hotels: up to 150 a night." : "Hotels: up to 180 a night, 220 in London.",
  }),
} as AgentTool;

const delegate = (callId: string, task: string) => ({ callId, name: "delegate", input: { task } });

describe("the orchestrator", () => {
  it("hands each sub-task to a child run and reads back only the children's final answers", async () => {
    const tasks: string[] = [];
    const children = new Map<string, readonly { data: RunEventData }[]>();
    const childModels = [
      scriptedTurns([
        { toolCalls: [{ callId: "r", name: "read_document", input: { documentId: "v1" } }] },
        { text: "v1: hotels up to 150 a night." },
      ]).model,
      scriptedTurns([
        { toolCalls: [{ callId: "r", name: "read_document", input: { documentId: "v2" } }] },
        { text: "v2: hotels up to 180, 220 in London." },
      ]).model,
    ];
    const runChild: RunChild = async (task, ctx) => {
      tasks.push(task);
      const child = inMemoryRun(childRunId(ctx.runId, ctx.callId));
      child.append({ type: "user_message", messageId: "task", text: task });
      await drive(child, { model: childModels[tasks.length - 1], tools: [readDoc], viewer });
      children.set(child.runId, child.events);
      return childOutcome(child.events);
    };

    const parent = inMemoryRun("parent");
    parent.append({ type: "user_message", messageId: "m1", text: "Compare what v1 and v2 say about hotels" });
    const { model } = scriptedTurns([
      {
        toolCalls: [
          delegate("c1", "Read the expenses policy v1 and report its hotel rules"),
          delegate("c2", "Read the expenses policy v2 and report its hotel rules"),
        ],
      },
      { text: "v2 raises the hotel cap from 150 to 180 (220 in London)." },
    ]);
    const done = await drive(parent, { model, tools: [readDoc, delegateTool({ runChild })], viewer });

    expect(done).toMatchObject({ kind: "finish", status: "succeeded" });
    expect(tasks).toHaveLength(2);
    const results = parent.events.flatMap((e) => (e.data.type === "tool_result" ? [e.data] : []));
    expect(results).toEqual([
      {
        type: "tool_result",
        callId: "c1",
        ok: true,
        output: { runId: childRunId("parent", "c1"), summary: "v1: hotels up to 150 a night." },
      },
      {
        type: "tool_result",
        callId: "c2",
        ok: true,
        output: { runId: childRunId("parent", "c2"), summary: "v2: hotels up to 180, 220 in London." },
      },
    ]);
    // Each child kept its own log; the parent's has none of the children's tool calls.
    expect(children.size).toBe(2);
    expect(parent.events.some((e) => e.data.type === "tool_result" && e.data.callId === "r")).toBe(false);
  });

  it("gives a child that fails back to the parent as a failed tool result", async () => {
    const parent = inMemoryRun("parent");
    parent.append({ type: "user_message", messageId: "m1", text: "Compare v1 and v2" });
    const runChild: RunChild = async (task) =>
      task.includes("v2")
        ? { status: "failed", summary: "", reason: "cap reached: 30000 tokens" }
        : { status: "succeeded", summary: "v1 says 150." };
    const { model } = scriptedTurns([
      { toolCalls: [delegate("c1", "v1 hotels"), delegate("c2", "v2 hotels")] },
      { text: "I could only read v1." },
    ]);
    await drive(parent, { model, tools: [delegateTool({ runChild })], viewer });
    const results = parent.events.flatMap((e) => (e.data.type === "tool_result" ? [e.data] : []));
    expect(results[0]).toMatchObject({ ok: true, output: { summary: "v1 says 150." } });
    expect(results[1]).toEqual({
      type: "tool_result",
      callId: "c2",
      ok: false,
      error: "The sub-agent failed: cap reached: 30000 tokens.",
    });
  });

  it("answers that sub-agents need the Workflow runner when nothing can run them", async () => {
    const parent = inMemoryRun("parent");
    parent.append({ type: "user_message", messageId: "m1", text: "go" });
    const { model } = scriptedTurns([{ toolCalls: [delegate("c1", "x")] }, { text: "ok" }]);
    await drive(parent, { model, tools: [delegateTool()], viewer });
    expect(parent.events.find((e) => e.data.type === "tool_result")!.data).toMatchObject({
      ok: false,
      error: expect.stringContaining("Workflow runner"),
    });
  });

  it("splits the parent's tokens and tool calls between the children of a turn", () => {
    expect(childCaps(DEFAULT_CAPS, 2)).toEqual({ ...DEFAULT_CAPS, tokens: 30_000, toolCalls: 15 });
    expect(childCaps(DEFAULT_CAPS, 0)).toEqual(DEFAULT_CAPS);
  });

  it("derives one child id per call, stable across retries", () => {
    expect(childRunId("p", "c1")).toBe(childRunId("p", "c1"));
    expect(childRunId("p", "c1")).not.toBe(childRunId("p", "c2"));
    expect(childRunId("p", "c1")).toMatch(/^[0-9a-f-]{36}$/);
  });
});
