// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

/** Every hosted client the app builds goes through one of these two factories: counted here, never called out. */
const built = vi.hoisted(() => [] as string[]);

vi.mock("@ai-sdk/openai", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@ai-sdk/openai")>();
  return {
    ...mod,
    createOpenAI: (...args: Parameters<typeof mod.createOpenAI>) => {
      built.push("openai");
      return mod.createOpenAI(...args);
    },
  };
});
vi.mock("@ai-sdk/cohere", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@ai-sdk/cohere")>();
  return {
    ...mod,
    createCohere: (...args: Parameters<typeof mod.createCohere>) => {
      built.push("cohere");
      return mod.createCohere(...args);
    },
  };
});

const KEYS = { OPENAI_API_KEY: "sk-test-not-real", COHERE_API_KEY: "co-test-not-real" };
/** The pools connect on their first query, and none is made. */
const NO_DATABASE = { DATABASE_URL: "postgres://ac_app:unused@127.0.0.1:1/unused" };
const VIEWER = { tenantId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" };

/** Builds the model of every chat and agent path, the way the app does, in a fresh module graph (the chat model is
 * cached per process). Nothing is called: building a model makes no request. */
async function buildEveryPath(env: Record<string, string>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const providers: string[] = [];

  const { chatModelFromEnv, chatDeps } = await import("@/routes/api/chat/-deps");
  providers.push(chatModelFromEnv().id, chatDeps().model.id);

  const { retrievalDepsFromEnv, embedderFromEnv } = await import("@/lib/retrieval.server");
  const retrieval = retrievalDepsFromEnv();
  providers.push(retrieval.reranker.name, retrieval.embedder.version, embedderFromEnv().version);

  const { agentRuntime } = await import("@/lib/agent-runtime");
  agentRuntime().loop(VIEWER);

  const { RuntimeModel } = await import("@/workflows/workflow-agent");
  const runtime = new RuntimeModel("gpt-6-luna") as unknown as { model(): { provider: string; modelId: string } };
  const model = runtime.model();
  providers.push(`${model.provider}:${model.modelId}`);
  return providers;
}

afterEach(() => {
  vi.unstubAllEnvs();
  built.length = 0;
});

describe("MODEL_PROVIDER=local builds no hosted client", () => {
  it("on the chat, the router, retrieval, the agent runner and the WorkflowAgent comparison, keys set or not", async () => {
    const providers = await buildEveryPath({ AC_ENV: "dev", MODEL_PROVIDER: "local", ...KEYS, ...NO_DATABASE });
    expect(built, "local mode must never build an OpenAI or Cohere client: the air gap is the point").toEqual([]);
    expect(providers.at(-1), "WorkflowAgent's model is LM Studio's chat model, whatever model id it carries").toBe(
      "lmstudio.chat:qwen/qwen3-8b",
    );
  });

  it("hosted, as before: the same paths build OpenAI and Cohere (so the count above can see them)", async () => {
    const providers = await buildEveryPath({ AC_ENV: "dev", MODEL_PROVIDER: "hosted", ...KEYS, ...NO_DATABASE });
    expect(new Set(built)).toEqual(new Set(["openai", "cohere"]));
    expect(providers.at(-1)).toBe("openai.responses:gpt-6-luna");
  });
});
