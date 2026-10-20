import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { LOCAL_DEFAULTS, localConfig, modelProvider } from "./config";

describe("modelProvider", () => {
  it("is hosted unless MODEL_PROVIDER says local", () => {
    expect(modelProvider({})).toBe("hosted");
    expect(modelProvider({ MODEL_PROVIDER: "" })).toBe("hosted");
    expect(modelProvider({ MODEL_PROVIDER: "hosted" })).toBe("hosted");
    expect(modelProvider({ MODEL_PROVIDER: "local" })).toBe("local");
  });

  it("refuses anything else, so a typo can't quietly run hosted", () => {
    expect(() => modelProvider({ MODEL_PROVIDER: "lcoal" })).toThrow(/hosted" or "local/);
  });
});

describe("localConfig", () => {
  it("has the defaults the measurements used", () => {
    expect(localConfig({})).toEqual({
      ...LOCAL_DEFAULTS,
      weightsDir: resolve(LOCAL_DEFAULTS.weightsDir),
    });
  });

  it("takes each value from the environment", () => {
    const config = localConfig({
      LMSTUDIO_BASE_URL: "http://10.0.0.5:1234/v1",
      LOCAL_CHAT_MODEL: "google/gemma-4-31b",
      LOCAL_EMBEDDING_MODEL: "other-embed",
      LOCAL_EMBEDDING_DIMENSIONS: "1024",
      LOCAL_RERANKER_MODEL: "org/reranker",
      LOCAL_RERANKER_DTYPE: "fp32",
      LOCAL_WEIGHTS_DIR: "/srv/weights",
    });
    expect(config).toEqual({
      baseURL: "http://10.0.0.5:1234/v1",
      chatModel: "google/gemma-4-31b",
      embeddingModel: "other-embed",
      embeddingDimensions: 1024,
      rerankerModel: "org/reranker",
      rerankerDtype: "fp32",
      weightsDir: "/srv/weights",
    });
  });

  it("refuses a dimension or dtype it can't use", () => {
    expect(() => localConfig({ LOCAL_EMBEDDING_DIMENSIONS: "768.5" })).toThrow(/whole number/);
    expect(() => localConfig({ LOCAL_RERANKER_DTYPE: "q4" })).toThrow(/fp32 or q8/);
  });
});
