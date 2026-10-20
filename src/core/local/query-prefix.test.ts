// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { embedderFromEnv, retrievalDepsFromEnv } from "@/lib/retrieval.server";

/** LM Studio's embeddings endpoint, stood in: it records each request's inputs and answers 768 zeros apiece. */
function lmStudioStandIn() {
  const inputs: string[][] = [];
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
    const { input } = JSON.parse(String(init.body)) as { input: string[] };
    inputs.push(input);
    return Response.json({
      object: "list",
      data: input.map((_, index) => ({ object: "embedding", index, embedding: Array.from({ length: 768 }, () => 0) })),
      model: "text-embedding-nomic-embed-text-v1.5",
      usage: { prompt_tokens: 1, total_tokens: 1 },
    });
  });
  return inputs;
}

afterEach(() => vi.unstubAllGlobals());

const LOCAL = { AC_ENV: "dev", MODEL_PROVIDER: "local" };

describe("a search on local models", () => {
  it("embeds the question as a query, for the chat, the labs and ex smoke alike", async () => {
    const inputs = lmStudioStandIn();
    await retrievalDepsFromEnv(LOCAL).embedder.embed(["What is the nightly limit for a hotel in London?"]);
    expect(inputs).toEqual([["search_query: What is the nightly limit for a hotel in London?"]]);
  });

  it("leaves documents to the embedder's default, as ingest and `pnpm local:db` embed them", async () => {
    const inputs = lmStudioStandIn();
    await embedderFromEnv(LOCAL).embed(["## 4. Limits"]);
    expect(inputs).toEqual([["search_document: ## 4. Limits"]]);
  });

  it("is the app's hosted search when MODEL_PROVIDER is unset", () => {
    const deps = retrievalDepsFromEnv({ AC_ENV: "dev", OPENAI_API_KEY: "sk-test-not-real", COHERE_API_KEY: "x" });
    expect(deps.embedder.version).toBe("text-embedding-3-small@1536");
    expect(deps.reranker.name).toBe("cohere/rerank-v4.0-fast");
  });
});
