// @vitest-environment node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

import { type BundlePart, bundleTotal, type ComposeConfig, composeImages, gb } from "#learn/local/vendor";
import { fetchWeights, RERANKER_WEIGHTS, type WeightManifest } from "#learn/local/weights";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/**
 * Watches every way a file can be moved or copied into place, sync or not: after each one, `afterMove` (when a test
 * sets it) looks at what the target holds. The functions still do what they always do.
 */
const moves = vi.hoisted(() => ({ afterMove: null as null | ((how: string) => void) }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const watched = <F extends (...args: never[]) => unknown>(how: string, fn: F) =>
    ((...args: Parameters<F>) => {
      const out = fn(...args);
      moves.afterMove?.(how);
      return out;
    }) as unknown as F;
  const overrides = {
    renameSync: watched("renameSync", fs.renameSync),
    copyFileSync: watched("copyFileSync", fs.copyFileSync),
    cpSync: watched("cpSync", fs.cpSync),
    linkSync: watched("linkSync", fs.linkSync),
  };
  return { ...fs, ...overrides, default: { ...fs, ...overrides } };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const fsp = await importOriginal<typeof import("node:fs/promises")>();
  const watched = <F extends (...args: never[]) => Promise<unknown>>(how: string, fn: F) =>
    (async (...args: Parameters<F>) => {
      const out = await fn(...args);
      moves.afterMove?.(how);
      return out;
    }) as unknown as F;
  const overrides = {
    rename: watched("rename", fsp.rename),
    copyFile: watched("copyFile", fsp.copyFile),
    cp: watched("cp", fsp.cp),
    link: watched("link", fsp.link),
  };
  return { ...fsp, ...overrides, default: { ...fsp, ...overrides } };
});

const FILES: Record<string, Buffer> = {
  "config.json": Buffer.from('{"id2label":{"0":"LABEL_0"}}'),
  "onnx/model_quantized.onnx": Buffer.from("int8 weights ".repeat(400)),
};
const MANIFEST: WeightManifest = {
  repo: "kestrel/tiny-reranker",
  revision: "9f1c2e7a4b6d8e0f1a2b3c4d5e6f708192a3b4c5",
  license: "MIT",
  files: Object.entries(FILES).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) })),
};
const MODEL = "onnx/model_quantized.onnx";
const url = (path: string) => `https://huggingface.co/${MANIFEST.repo}/resolve/${MANIFEST.revision}/${path}`;

/** A stand-in Hugging Face: serves the files at their pinned URLs, and remembers what was asked for. */
function hub(serve: (path: string, bytes: Buffer) => Response = (_path, bytes) => new Response(new Uint8Array(bytes))) {
  const requested: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const href = String(input);
    requested.push(href);
    const entry = Object.entries(FILES).find(([path]) => href === url(path));
    return entry ? serve(entry[0], entry[1]) : new Response("Entry not found", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, requested };
}

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});
function weightsDir() {
  const dir = mkdtempSync(join(tmpdir(), "weights-"));
  dirs.push(dir);
  return dir;
}
const at = (dir: string, path: string) => join(dir, MANIFEST.repo, path);
function place(dir: string, path: string, bytes: Buffer) {
  mkdirSync(dirname(at(dir, path)), { recursive: true });
  writeFileSync(at(dir, path), bytes);
}
/** Everything in the model's folder, so a test can say nothing was left behind. */
const leftovers = (dir: string) =>
  existsSync(join(dir, MANIFEST.repo)) ? readdirSync(join(dir, MANIFEST.repo), { recursive: true }).map(String) : [];

async function failed(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "no error",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

describe("fetchWeights", () => {
  it("downloads each file from the pinned revision into the model's folder", async () => {
    const dir = weightsDir();
    const { fetch, requested } = hub();
    const result = await fetchWeights(MANIFEST, dir, { fetch });
    expect(
      requested.sort(),
      "https://huggingface.co/<repo>/resolve/<revision>/<path>: the commit, never main, which moves",
    ).toEqual([url("config.json"), url(MODEL)].sort());
    expect(result).toEqual({ downloaded: ["config.json", MODEL], kept: [] });
    expect(readFileSync(at(dir, MODEL)).equals(FILES[MODEL]!), "the file lands at <dir>/<repo>/<path>").toBe(true);
  });

  it("keeps a file that's already there and right, and fetches nothing for it", async () => {
    const dir = weightsDir();
    place(dir, "config.json", FILES["config.json"]!);
    const { fetch, requested } = hub();
    const result = await fetchWeights(MANIFEST, dir, { fetch });
    expect(result, "verifyWeights said ok: keep it").toEqual({ downloaded: [MODEL], kept: ["config.json"] });
    expect(requested).toEqual([url(MODEL)]);
  });

  it("replaces a file that's there but wrong", async () => {
    const dir = weightsDir();
    place(dir, MODEL, FILES[MODEL]!.subarray(0, 100));
    await fetchWeights(MANIFEST, dir, { fetch: hub().fetch });
    expect(readFileSync(at(dir, MODEL)).equals(FILES[MODEL]!)).toBe(true);
  });

  it("refuses a download of the wrong size, and leaves nothing where the reranker loads", async () => {
    const dir = weightsDir();
    const { fetch } = hub(
      (path, bytes) => new Response(new Uint8Array(path === MODEL ? bytes.subarray(0, 1000) : bytes)),
    );
    const message = await failed(fetchWeights(MANIFEST, dir, { fetch }));
    expect(message, "throw, naming the file").toContain(MODEL);
    expect(
      existsSync(at(dir, MODEL)),
      "write to <target>.partial, check it, and only then rename it: a bad file never sits at the target",
    ).toBe(false);
    expect(leftovers(dir), "a file that doesn't match is deleted").not.toContain(`${MODEL}.partial`);
  });

  it("catches a file of the right size with other bytes in it: the hash, not just the size", async () => {
    const dir = weightsDir();
    const swapped = Buffer.from(FILES[MODEL]!);
    swapped[42] = swapped[42]! ^ 1;
    const { fetch } = hub((path, bytes) => new Response(new Uint8Array(path === MODEL ? swapped : bytes)));
    const message = await failed(fetchWeights(MANIFEST, dir, { fetch }));
    expect(message, "one bit differs, so the sha256 does: compare it with the manifest's").toContain(MODEL);
    expect(existsSync(at(dir, MODEL))).toBe(false);
  });

  it("checks the download before it moves it: the target never holds a bad file, even for a moment", async () => {
    const dir = weightsDir();
    const swapped = Buffer.from(FILES[MODEL]!);
    swapped[7] = swapped[7]! ^ 1;
    const bad: string[] = [];
    moves.afterMove = (how) => {
      const target = at(dir, MODEL);
      if (existsSync(target) && sha256(readFileSync(target)) !== sha256(FILES[MODEL]!)) bad.push(how);
    };
    try {
      for (const body of [swapped, FILES[MODEL]!.subarray(0, 1000)]) {
        const { fetch } = hub((path, bytes) => new Response(new Uint8Array(path === MODEL ? body : bytes)));
        expect(await failed(fetchWeights(MANIFEST, dir, { fetch }))).toContain(MODEL);
      }
    } finally {
      moves.afterMove = null;
    }
    expect(
      bad,
      "the bad bytes were moved to the target, then checked: check <target>.partial first, and rename only a match. " +
        "A crash between the rename and the check would leave them where the reranker loads",
    ).toEqual([]);
  });

  it("leaves the target alone when a download is cut off halfway", async () => {
    const dir = weightsDir();
    const { fetch } = hub((path, bytes) => {
      if (path !== MODEL) return new Response(new Uint8Array(bytes));
      const cut = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(bytes.subarray(0, 2000));
          controller.error(new Error("connection reset"));
        },
      });
      return new Response(cut);
    });
    expect(await failed(fetchWeights(MANIFEST, dir, { fetch }))).not.toBe("no error");
    expect(existsSync(at(dir, MODEL)), "a cut download stays under its temporary name").toBe(false);
    expect(existsSync(at(dir, "config.json")), "the file before it, downloaded whole, is in place").toBe(true);
  });

  it("stops on a server error instead of saving it as weights", async () => {
    const dir = weightsDir();
    const { fetch } = hub((path, bytes) =>
      path === MODEL ? new Response("rate limited", { status: 429 }) : new Response(new Uint8Array(bytes)),
    );
    const message = await failed(fetchWeights(MANIFEST, dir, { fetch }));
    expect(message, "check response.ok before reading the body").toMatch(/429/);
    expect(existsSync(at(dir, MODEL))).toBe(false);
  });
});

const COMPOSE = parse(readFileSync(join(process.cwd(), "compose.yaml"), "utf8")) as ComposeConfig;

describe("composeImages", () => {
  it("takes compose.yaml's default services and the airgap profile, the paradedb image once", () => {
    expect(
      composeImages(COMPOSE, false),
      "paradedb, airgap-db and airgap-probe share one image; docling and otel-lgtm are other sections' profiles",
    ).toEqual(["paradedb/paradedb:0.26.1-pg18"]);
  });

  it("takes every profile with all", () => {
    expect(composeImages(COMPOSE, true).sort()).toEqual([
      "grafana/otel-lgtm:0.37.0",
      "paradedb/paradedb:0.26.1-pg18",
      "quay.io/docling-project/docling-serve-cpu:v1.35.0",
    ]);
  });

  it("counts a service with no profiles as one that starts, and airgap among several profiles", () => {
    const config: ComposeConfig = {
      services: {
        app: { image: "app:1" },
        grafana: { image: "grafana:2", profiles: ["observability"] },
        probe: { image: "probe:3", profiles: ["observability", "airgap"] },
      },
    };
    expect(composeImages(config, false)).toEqual(["app:1", "probe:3"]);
  });
});

describe("the bundle", () => {
  it("is 3.83 GB for what an air-gapped Kestrel needs, as the dry run measured it", () => {
    const dryRun = JSON.parse(
      readFileSync(join(process.cwd(), "fixtures/local/reports/2026-10-21-vendor-dry-run.json"), "utf8"),
    ) as { needed: BundlePart[]; optional: BundlePart[] };
    const measured = [...dryRun.needed, ...dryRun.optional];
    const images = composeImages(COMPOSE, false).map(
      (image) => measured.find((part) => part.source === image) ?? { part: image, source: image, bytes: null },
    );
    const parts = [...dryRun.needed.filter((part) => !part.part.startsWith("images/")), ...images];
    expect(
      images.map((part) => gb(part.bytes ?? 0)),
      "one paradedb image, 1.49 GB",
    ).toEqual(["1.49 GB"]);
    expect(gb(bundleTotal(parts)), "pnpm store 1.96 + paradedb 1.49 + reranker 0.30 + nomic 0.08").toBe("3.83 GB");
    expect(
      parts.filter((part) => part.bytes === null).map((part) => part.part),
      "still to download",
    ).toEqual(["models/lmstudio/qwen/qwen3-8b"]);

    const weights = RERANKER_WEIGHTS.files.reduce((sum, file) => sum + file.bytes, 0);
    expect(weights, "the reranker's five files, each with its sha256").toBe(296_400_660);
  });
});
