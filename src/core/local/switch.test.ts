// @vitest-environment node
import { describe, expect, it } from "vitest";

import { embedderFromEnv, rerankerFromEnv, rewriterFromEnv } from "@/lib/retrieval.server";
import { chatModelFromEnv } from "@/routes/api/chat/-deps";

/** The switch where the app picks its models. Nothing here calls a model: building one makes no request. */
describe("MODEL_PROVIDER=local", () => {
  const keys = { OPENAI_API_KEY: "sk-test-not-real", COHERE_API_KEY: "co-test-not-real" };

  it("picks every model local, whatever keys are set", () => {
    const env = { AC_ENV: "dev", MODEL_PROVIDER: "local", ...keys };
    expect(embedderFromEnv(env).version).toBe("text-embedding-nomic-embed-text-v1.5@768");
    expect(embedderFromEnv(env).dimensions).toBe(1536);
    expect(rerankerFromEnv(env).name).toBe("local/Xenova/bge-reranker-base@q8");
    expect(rewriterFromEnv(env)).toBeTypeOf("function");
    expect(chatModelFromEnv(env).id).toBe("lmstudio.chat:qwen/qwen3-8b");
  });

  it("works in production too, where a hosted model without a key would refuse", () => {
    const env = { AC_ENV: "prod", MODEL_PROVIDER: "local" };
    expect(embedderFromEnv(env).version).toBe("text-embedding-nomic-embed-text-v1.5@768");
    expect(rerankerFromEnv(env).name).toMatch(/^local\//);
  });

  it("leaves tests on the fakes, and hosted as it was", () => {
    expect(embedderFromEnv({ AC_ENV: "test", MODEL_PROVIDER: "local", ...keys }).version).toBe("fake-hashing-v1@1536");
    expect(rerankerFromEnv({ AC_ENV: "test", MODEL_PROVIDER: "local" }).name).toBe("fake-overlap-v1");
    const hosted = { AC_ENV: "dev", ...keys };
    expect(embedderFromEnv(hosted).version).toBe("text-embedding-3-small@1536");
    expect(rerankerFromEnv(hosted).name).toBe("cohere/rerank-v4.0-fast");
  });

  it("refuses a provider it doesn't know", () => {
    expect(() => embedderFromEnv({ AC_ENV: "dev", MODEL_PROVIDER: "ollama" })).toThrow(/MODEL_PROVIDER/);
  });
});
