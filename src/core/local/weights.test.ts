// @vitest-environment node
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { fetchWeights, verifyWeights, type WeightManifest } from "./weights";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const CONTENT: Record<string, string> = { "config.json": '{"a":1}', "onnx/model_quantized.onnx": "weights" };
const manifest: WeightManifest = {
  repo: "org/model",
  revision: "abc123",
  license: "MIT",
  files: Object.entries(CONTENT).map(([path, text]) => ({ path, bytes: text.length, sha256: sha(text) })),
};

function hub(serve: (path: string) => string = (path) => CONTENT[path]) {
  const urls: string[] = [];
  const fetch = async (input: RequestInfo | URL) => {
    urls.push(String(input));
    const path = String(input).split("/resolve/abc123/")[1];
    return new Response(serve(path));
  };
  return { fetch: fetch as typeof globalThis.fetch, urls };
}

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const fresh = () => (dir = mkdtempSync(join(tmpdir(), "weights-")));

describe("fetchWeights", () => {
  it("downloads each file from the pinned revision and checks it", async () => {
    fresh();
    const { fetch, urls } = hub();
    const result = await fetchWeights(manifest, dir, { fetch });
    expect(urls).toEqual([
      "https://huggingface.co/org/model/resolve/abc123/config.json",
      "https://huggingface.co/org/model/resolve/abc123/onnx/model_quantized.onnx",
    ]);
    expect(result).toEqual({ downloaded: ["config.json", "onnx/model_quantized.onnx"], kept: [] });
    expect(readFileSync(join(dir, "org/model/onnx/model_quantized.onnx"), "utf8")).toBe("weights");
    expect((await verifyWeights(manifest, dir)).every((file) => file.status === "ok")).toBe(true);
  });

  it("keeps files that are already right, and replaces a wrong one", async () => {
    fresh();
    mkdirSync(join(dir, "org/model"), { recursive: true });
    writeFileSync(join(dir, "org/model/config.json"), CONTENT["config.json"]);
    const onnx = join(dir, "org/model/onnx/model_quantized.onnx");
    mkdirSync(dirname(onnx), { recursive: true });
    writeFileSync(onnx, "wrongly");
    expect((await verifyWeights(manifest, dir)).map((file) => file.status)).toEqual(["ok", "wrong hash"]);

    const result = await fetchWeights(manifest, dir, hub());
    expect(result).toEqual({ downloaded: ["onnx/model_quantized.onnx"], kept: ["config.json"] });
  });

  it("deletes a download that doesn't match and fails, leaving nothing where the model would load it", async () => {
    fresh();
    const { fetch } = hub((path) => (path === "config.json" ? CONTENT[path] : "tampers"));
    await expect(fetchWeights(manifest, dir, { fetch })).rejects.toThrow(/onnx\/model_quantized.onnx: got 7 bytes/);
    expect(existsSync(join(dir, "org/model/onnx/model_quantized.onnx"))).toBe(false);
    expect(existsSync(join(dir, "org/model/onnx/model_quantized.onnx.partial"))).toBe(false);
  });
});
