// @vitest-environment node
import { describe, expect, it } from "vitest";

import { LOCAL_ONLY_PACKAGES, LOCAL_TRACE_DEPS, localBuild, NO_LOCAL_MODELS } from "./build";

describe("the local-only build switch", () => {
  it("is off unless LOCAL_BUILD=1, and refuses anything else", () => {
    expect(localBuild({})).toBe(false);
    expect(localBuild({ LOCAL_BUILD: "0" })).toBe(false);
    expect(localBuild({ LOCAL_BUILD: "1" })).toBe(true);
    expect(() => localBuild({ LOCAL_BUILD: "yes" })).toThrow(/LOCAL_BUILD must be 1/);
  });

  it("traces transformers.js and onnxruntime-node whole into a local build", () => {
    expect(LOCAL_ONLY_PACKAGES).toEqual(["@huggingface/transformers"]);
    expect(LOCAL_TRACE_DEPS).toContain("onnxruntime-node*");
  });

  it("gives a hosted build a module that says how to get local models, instead of a missing native one", async () => {
    await expect(import(/* @vite-ignore */ NO_LOCAL_MODELS)).rejects.toThrow(/pnpm build:local/);
  });
});
