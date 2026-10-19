// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { AgentTool } from "#learn/agent/types";

import { parseCall, runTool, toolSpecs } from "#learn/agent/loop";
import { drive, inMemoryRun } from "#learn/agent/loop-testing";
import { scriptedTurns } from "#learn/model/testing";
import { countToolTokens } from "#learn/model/tokens";
import { recordedRun, replayTools } from "@/core/agent/loop-recorded";

const viewer = { tenantId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222" };
const MSA = "ab8c3047-7d49-4f3f-87a1-47aceb15df22";
const tools = () => replayTools("kpc-terms");
const find = (name: string) => tools().find((t) => t.name === name)!;

describe("toolSpecs", () => {
  it("sends each tool's zod schema as JSON Schema, in the registry's order", () => {
    const specs = toolSpecs(tools());
    expect(specs.map((s) => s.name)).toEqual([
      "make_plan",
      "search_documents",
      "read_document",
      "find_person",
      "send_mail",
      "share_document",
    ]);
    for (const spec of specs) {
      expect("$schema" in spec.inputSchema, `${spec.name}: zod's $schema key isn't part of a tool's input`).toBe(false);
    }
    expect(specs.find((s) => s.name === "read_document")).toEqual({
      name: "read_document",
      description: find("read_document").description,
      inputSchema: {
        type: "object",
        properties: {
          documentId: {
            type: "string",
            format: "uuid",
            pattern: expect.any(String),
            description: "The document's id, from search_documents.",
          },
          fromChunk: {
            anyOf: [{ type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, { type: "null" }],
            description: "Where to continue: the nextChunk of an earlier read; null to start.",
          },
        },
        required: ["documentId", "fromChunk"],
      },
    });
  });

  it("describes the input the model sends: a field with a default isn't required of it", () => {
    const search = {
      name: "search",
      description: "Search",
      input: z.object({ query: z.string(), k: z.int().default(8) }),
      effect: "read",
      needsApproval: () => false,
      execute: async () => null,
    } as AgentTool;
    expect(
      toolSpecs([search])[0].inputSchema.required,
      "the model writes the input, so describe the input side (io: input): k has a default",
    ).toEqual(["query"]);
  });

  it("costs 1,474 tokens for the app's six tools, on every request", () => {
    expect(countToolTokens(toolSpecs(tools()))).toBe(1474);
  });
});

describe("parseCall", () => {
  const parse = (tool: string, input: unknown) => {
    try {
      return parseCall({ callId: "c1", tool, input }, tools());
    } catch (error) {
      return expect.fail(
        `parseCall threw (${String(error).replace(/\s+/g, " ").slice(0, 60)}...): an unknown tool or a bad input is the model's mistake ` +
          "to fix, so return it as { error }",
      );
    }
  };

  it("names a tool that doesn't exist", () => {
    expect(parse("search_document", { query: "KPC-2026-0142" })).toEqual({
      error: "There is no tool called search_document.",
    });
  });

  it("refuses input the schema doesn't allow, in zod's words, and never throws", () => {
    expect(parse("read_document", { documentId: "KPC-2026-0142", fromChunk: null })).toEqual({
      error: "Invalid input: ✖ Invalid UUID\n  → at documentId",
    });
    expect(parse("read_document", { documentId: MSA, fromChunk: "3" })).toEqual({
      error: "Invalid input: ✖ Invalid input: expected number, received string\n  → at fromChunk",
    });
    expect(parse("search_documents", { query: "payment terms", k: 12 })).toEqual({
      error: "Invalid input: ✖ Too big: expected number to be <=8\n  → at k",
    });
    // Arguments the model wrote that weren't JSON arrive as the raw string.
    expect(parse("find_person", '{"query": "Tom')).toMatchObject({ error: expect.stringMatching(/^Invalid input: /) });
  });

  it("returns the registry's tool and the parsed input, without keys the schema doesn't name", () => {
    const parsed = parse("read_document", { documentId: MSA, fromChunk: null, adminOverride: true });
    expect(parsed, "the input is zod's parsed value, so adminOverride (not in the schema) is gone").toEqual({
      tool: expect.anything(),
      input: { documentId: MSA, fromChunk: null },
    });
    expect("tool" in parsed && parsed.tool.name).toBe("read_document");
  });
});

describe("a bad input, fed back", () => {
  it("refuses the contract number where the document id goes; the model reads why and fixes it", async () => {
    const recordedRead = recordedRun("kpc-terms").tools.find((t) => t.tool === "read_document")!.callId;
    const { model, mock } = scriptedTurns([
      { toolCalls: [{ callId: "c1", name: "read_document", input: { documentId: "KPC-2026-0142", fromChunk: null } }] },
      { toolCalls: [{ callId: recordedRead, name: "read_document", input: { documentId: MSA, fromChunk: null } }] },
      { text: "Payment is due within 30 days." },
    ]);
    const run = inMemoryRun();
    run.append({ type: "user_message", messageId: "m1", text: "Read KPC-2026-0142." });
    // No make_plan: this run doesn't plan (section 17), so nothing forces the first call.
    const reads = tools().filter((t) => t.name !== "make_plan");
    expect(await drive(run, { model, tools: reads, viewer })).toEqual({
      kind: "finish",
      status: "succeeded",
    });
    const results = run.events.flatMap(({ data }) => (data.type === "tool_result" ? [data] : []));
    expect(results[0], "the bad call fails with zod's words, and the tool never runs").toEqual({
      type: "tool_result",
      callId: "c1",
      ok: false,
      error: "Invalid input: ✖ Invalid UUID\n  → at documentId",
    });
    expect(results[1]).toMatchObject({ ok: true, output: { title: "KPC-2026-0142 Ashgrove MSA (executed).pdf" } });
    expect(mock.doStreamCalls[1].prompt.at(-1), "the second turn reads the error as the call's result").toMatchObject({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "c1", output: { type: "error-text" } }],
    });
  });

  it("runs a call whose input passes, with the parsed input", async () => {
    const recordedRead = recordedRun("kpc-terms").tools.find((t) => t.tool === "read_document")!.callId;
    const result = await runTool(
      { callId: recordedRead, tool: "read_document", input: { documentId: MSA, fromChunk: null, extra: 1 } },
      { tools: tools(), viewer, runId: "run-1" },
    );
    expect(result).toMatchObject({ ok: true, output: { documentId: MSA } });
  });
});
