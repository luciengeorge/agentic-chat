// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { localChatModel } from "./lmstudio";

/** Answers as LM Studio's Chat Completions endpoint does, and keeps each request. */
function fakeLmStudio(reply: (body: Record<string, unknown>) => Response) {
  const requests: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url: String(input), body, headers: new Headers(init?.headers) });
    return reply(body);
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

const usage = { prompt_tokens: 84, completion_tokens: 19, completion_tokens_details: { reasoning_tokens: 8 } };
const config = { baseURL: "http://127.0.0.1:1234/v1", chatModel: "openai/gpt-oss-20b" };

describe("localChatModel", () => {
  it("answers structured output through json_schema, with the effort as reasoning_effort and no API key", async () => {
    const lm = fakeLmStudio(() =>
      Response.json({
        id: "c1",
        created: 0,
        model: config.chatModel,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: '{"queries":["London hotel limit"]}', reasoning: "" },
            finish_reason: "stop",
          },
        ],
        usage,
      }),
    );
    const model = localChatModel(config, { fetch: lm.fetch });

    const result = await model.object(
      {
        instructions: "Rewrite.",
        messages: [{ role: "user", content: "hotel London" }],
        name: "search_queries",
        reasoningEffort: "medium",
      },
      z.object({ queries: z.array(z.string()) }),
    );

    expect(result.object).toEqual({ queries: ["London hotel limit"] });
    expect(result.usage).toEqual({ inputTokens: 84, outputTokens: 19, reasoningTokens: 8 });
    const [request] = lm.requests;
    expect(request.url).toBe("http://127.0.0.1:1234/v1/chat/completions");
    expect(request.headers.get("authorization")).toBeNull();
    expect(request.body).toMatchObject({
      model: "openai/gpt-oss-20b",
      reasoning_effort: "medium",
      response_format: { type: "json_schema", json_schema: { name: "search_queries" } },
    });
    expect(model.id).toBe("lmstudio.chat:openai/gpt-oss-20b");
  });

  it("streams text and ends with the usage LM Studio reports", async () => {
    const chunk = (delta: object, extra: object = {}) =>
      `data: ${JSON.stringify({ id: "c2", created: 0, model: config.chatModel, choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
    const sse = [
      chunk({ role: "assistant", reasoning: "Sum it." }),
      chunk({ content: "39" }),
      chunk({ content: "1" }),
      `data: ${JSON.stringify({ id: "c2", created: 0, model: config.chatModel, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      `data: ${JSON.stringify({ id: "c2", created: 0, model: config.chatModel, choices: [], usage })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    const lm = fakeLmStudio(() => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
    const model = localChatModel(config, { fetch: lm.fetch });

    const events = [];
    for await (const event of model.stream({
      instructions: "Answer.",
      messages: [{ role: "user", content: "17*23?" }],
      reasoningEffort: "low",
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text-delta", delta: "39" },
      { type: "text-delta", delta: "1" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 84, outputTokens: 19, reasoningTokens: 8 } },
    ]);
    expect(lm.requests[0].body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: "low",
    });
  });
});
