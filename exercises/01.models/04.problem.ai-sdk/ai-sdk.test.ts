// @vitest-environment node
import { createOpenAI } from "@ai-sdk/openai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { ChatEvent, ChatRequest } from "#learn/model/types";

import { buildPrompt } from "#learn/generate/prompt";
import { aiSdkChatModel } from "#learn/model/ai-sdk";
import { responsesChatModel } from "#learn/model/responses";
import { scriptedObjects } from "#learn/model/testing";
import { countRequestTokens, countTokens } from "#learn/model/tokens";
import { modelRewriter } from "#learn/query/rewrite";
import { CASSETTE_QUESTION, CASSETTE_SOURCES, cassette, cassetteFetch } from "@/core/model/cassette";

const QUESTION = "How much can I spend on a hotel in London?";

/** gpt-6-luna through the AI SDK's own OpenAI provider, answering from a recording. */
function replayed(names: Parameters<typeof cassetteFetch>[0]) {
  const { fetch, requests } = cassetteFetch(names);
  return { model: aiSdkChatModel(createOpenAI({ apiKey: "sk-replay", fetch })("gpt-6-luna")), requests };
}

type Body = {
  input: Array<{ role: string; content: unknown }>;
  reasoning?: { effort?: string };
  text?: { format?: Record<string, unknown> };
};

describe("structured output through the AI SDK", () => {
  it("asks for a strict json_schema, named search_queries, with the effort it was given", async () => {
    const { model, requests } = replayed(["rewrite"]);
    await modelRewriter(model, "low")(QUESTION);
    const body = requests[0].body as Body;
    expect(body.text?.format, "use output: Output.object({ schema, name: request.name })").toMatchObject({
      type: "json_schema",
      strict: true,
      name: "search_queries",
      schema: {
        type: "object",
        properties: { queries: { type: "array", items: { type: "string" } } },
        required: ["queries"],
        additionalProperties: false,
      },
    });
    expect(body.reasoning?.effort, "pass the request's reasoningEffort as `reasoning`").toBe("low");
    expect(body.input[0], "the instructions go first, as a developer message").toEqual({
      role: "developer",
      content: expect.stringContaining("You turn a question to a company's internal search into search queries."),
    });
  });

  it("returns the recorded object, checked, and what the call was billed", async () => {
    const { model } = replayed(["rewrite"]);
    const Queries = z.object({ queries: z.array(z.string()) });
    const result = await model.object(
      {
        instructions: "Rewrite the question.",
        messages: [{ role: "user", content: QUESTION }],
        name: "search_queries",
        reasoningEffort: "low",
      },
      Queries,
    );
    expect(result, "the object from result.output; usage from result.totalUsage, reasoning tokens included").toEqual({
      object: {
        queries: [
          "London hotel accommodation spending limit per night",
          "lodging expense policy hotel nightly rate limits",
          "London hotel reimbursement budget cap",
        ],
      },
      usage: { inputTokens: 183, outputTokens: 35, reasoningTokens: 0 },
    });
  });

  it("throws when the reply doesn't match the schema, instead of handing it back", async () => {
    const { model } = scriptedObjects([{ queries: "London hotel" }]);
    const outcome = await modelRewriter(
      model,
      "low",
    )(QUESTION).then(
      (rewrites) => rewrites,
      (error: unknown) => error,
    );
    expect(
      outcome,
      "a string where the schema wants a list: let the SDK check it, don't JSON.parse the text",
    ).toBeInstanceOf(Error);
  });

  it("is a ChatModel too: the SDK reads the hand-written client's recording into the same events", async () => {
    const prompt = buildPrompt({ question: CASSETTE_QUESTION, chunks: CASSETTE_SOURCES });
    const request: ChatRequest = {
      instructions: prompt.instructions,
      messages: prompt.messages,
      reasoningEffort: "medium",
    };
    const collect = async (stream: AsyncIterable<ChatEvent>) => {
      const out: ChatEvent[] = [];
      for await (const event of stream) out.push(event);
      return out;
    };
    const bySdk = await collect(replayed(["answer"]).model.stream(request));
    const byHand = await collect(
      responsesChatModel({ model: "gpt-6-luna", apiKey: "sk-replay", fetch: cassetteFetch(["answer"]).fetch }).stream(
        request,
      ),
    );
    expect(bySdk).toHaveLength(55);
    expect(bySdk).toEqual(byHand);
  });

  it("bills 183 tokens for the rewrite, where the messages alone count 129: the schema is input too", async () => {
    const recorded = cassette("rewrite").request as Body & { input: Array<{ role: string; content: string }> };
    const instructions = recorded.input[0].content;
    const { model, requests } = replayed(["rewrite"]);
    const { usage } = await model.object(
      {
        instructions,
        messages: [{ role: "user", content: QUESTION }],
        name: "search_queries",
        reasoningEffort: "low",
      },
      // The rewriter's own schema, description and all, so what we send is what was billed.
      z.object({
        queries: z
          .array(z.string())
          .describe("Search queries for the same need, each different from the question and from each other"),
      }),
    );
    expect(usage.inputTokens).toBe(183);

    const counted = countRequestTokens({ instructions, messages: [{ role: "user", content: QUESTION }] });
    expect(counted).toEqual({ instructions: 114, messages: 15, tools: 0, total: 129 });
    const sent = requests[0].body as Body;
    const schema = countTokens(JSON.stringify((sent.text?.format as { schema: unknown }).schema));
    expect(schema).toBe(65);
    // 129 + 65 = 194, near the 183 billed. Forget the schema and the count is 54 tokens, 30%, short.
    expect(usage.inputTokens! - counted.total).toBe(54);
  });
});
