// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { ObjectRequest } from "./types";

import {
  buildObjectRequestBody,
  createObject,
  ResponsesApiError,
  responsesChatModel,
  strictJsonSchema,
} from "./responses";
import { scriptedObjects } from "./testing";

const Invoice = z.object({
  number: z.string().describe("The invoice number, as printed"),
  amount: z.number(),
  dueDate: z.string().nullable(),
});

const request: ObjectRequest = {
  instructions: "Read the invoice.",
  messages: [{ role: "user", content: "Invoice INV-2026-117, £1,240.00, due 30 Sept." }],
  name: "invoice",
  reasoningEffort: "low",
};

const usage = { input_tokens: 30, output_tokens: 12, output_tokens_details: { reasoning_tokens: 4 } };

/** A Responses reply in the documented non-streaming shape: a reasoning item, then the message. */
const reply = (content: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
  id: "resp_1",
  status: "completed",
  output: [
    { type: "reasoning", id: "rs_1", summary: [] },
    { type: "message", id: "msg_1", role: "assistant", content },
  ],
  usage,
  ...extra,
});

function fakeFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return Response.json(body, { status });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

describe("structured output by hand (Responses API)", () => {
  it("sends a strict JSON Schema in text.format, with no stream and nothing stored", () => {
    const body = buildObjectRequestBody(
      { model: "gpt-6-luna", input: [{ role: "user", content: "Hi" }], reasoningEffort: "low" },
      { name: "invoice", schema: strictJsonSchema(Invoice) },
    );
    expect(body).toMatchObject({
      stream: false,
      store: false,
      reasoning: { effort: "low" },
      text: {
        format: {
          type: "json_schema",
          name: "invoice",
          strict: true,
          schema: {
            type: "object",
            required: ["number", "amount", "dueDate"],
            additionalProperties: false,
            properties: { number: { type: "string", description: "The invoice number, as printed" } },
          },
        },
      },
    });
    expect(body.text.format.schema).not.toHaveProperty("$schema");
  });

  it("parses the message's text and checks it against the schema", async () => {
    const { fetch, calls } = fakeFetch(
      reply([{ type: "output_text", text: '{"number":"INV-2026-117","amount":1240,"dueDate":null}' }]),
    );
    const model = responsesChatModel({ apiKey: "sk-test", model: "gpt-6-luna", fetch });
    const result = await model.object(request, Invoice);
    expect(result).toEqual({
      object: { number: "INV-2026-117", amount: 1240, dueDate: null },
      usage: { inputTokens: 30, outputTokens: 12, reasoningTokens: 4 },
    });
    expect(calls[0].url).toBe("https://api.openai.com/v1/responses");
    expect(calls[0].body).toMatchObject({ instructions: "Read the invoice.", input: request.messages });
  });

  it("refuses an object that doesn't match, a refusal, and a reply cut off by max_output_tokens", async () => {
    const run = (body: unknown) =>
      createObject({ model: "m", name: "invoice", input: [], reasoningEffort: "low" }, Invoice, {
        apiKey: "k",
        fetch: fakeFetch(body).fetch,
      });
    await expect(run(reply([{ type: "output_text", text: '{"number":"INV-1"}' }]))).rejects.toBeInstanceOf(z.ZodError);
    await expect(run(reply([{ type: "refusal", refusal: "I can't help with that." }]))).rejects.toMatchObject({
      code: "refusal",
    });
    const cut = await run(
      reply([{ type: "output_text", text: '{"number":"INV' }], {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      }),
    ).catch((error: unknown) => error);
    expect(cut).toBeInstanceOf(ResponsesApiError);
    expect((cut as Error).message).toContain("max_output_tokens");
  });

  it("throws the API's error for an HTTP failure", async () => {
    const { fetch } = fakeFetch({ error: { message: "Invalid schema", code: "invalid_json_schema" } }, 400);
    const model = responsesChatModel({ apiKey: "k", model: "m", fetch });
    await expect(model.object(request, Invoice)).rejects.toMatchObject({ status: 400, code: "invalid_json_schema" });
  });
});

describe("structured output through the AI SDK", () => {
  it("asks for the named JSON format at the given effort, and returns the checked object with usage", async () => {
    const { model, mock } = scriptedObjects([{ number: "INV-2026-117", amount: 1240, dueDate: "2026-09-30" }]);
    const result = await model.object(request, Invoice);
    expect(result).toEqual({
      object: { number: "INV-2026-117", amount: 1240, dueDate: "2026-09-30" },
      usage: { inputTokens: 50, outputTokens: 10, reasoningTokens: 0 },
    });
    const [call] = mock.doGenerateCalls;
    expect(call.responseFormat).toMatchObject({ type: "json", name: "invoice" });
    expect(call.reasoning).toBe("low");
    expect(JSON.stringify(call.prompt)).toContain("Read the invoice.");
  });

  it("fails when the reply doesn't match the schema, or isn't JSON", async () => {
    const { model } = scriptedObjects([{ number: 117 }, "not json"]);
    await expect(model.object(request, Invoice)).rejects.toThrow();
    await expect(model.object(request, Invoice)).rejects.toThrow();
  });
});
