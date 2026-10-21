import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** A file of a vendored model: where it goes under the model's folder, its size and its sha256. */
export interface WeightFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface WeightManifest {
  /** The Hugging Face repo, which is also the folder under the weights directory. */
  repo: string;
  /** A commit, never a branch: a branch can move, and the hashes below would stop matching. */
  revision: string;
  license: string;
  files: WeightFile[];
}

/**
 * The reranker's weights: BAAI's bge-reranker-base (an XLM-RoBERTa cross-encoder, 278M parameters, one output
 * logit) as Xenova converted it to ONNX. The int8 file (`model_quantized.onnx`, 279 MB) is a quarter of the fp32
 * one. The tokenizer's `tokenizer.json` holds the whole vocabulary, so the sentencepiece model isn't needed.
 * The big files' hashes are Hugging Face's LFS ids. LFS (Git Large File Storage) keeps a big file outside the git
 * repo and names it by an id, which is the sha256 of its content, so the hub's id is the hash to check.
 */
export const RERANKER_WEIGHTS: WeightManifest = {
  repo: "Xenova/bge-reranker-base",
  revision: "280bcc27a84e0b898c251e06fddb25171bd9b101",
  license: "MIT (BAAI/bge-reranker-base)",
  files: [
    {
      path: "config.json",
      bytes: 782,
      sha256: "b6575b9d5be20d6747417c8e20c5a0db1636356e0b6d422d7244c628423c4d4c",
    },
    {
      path: "tokenizer_config.json",
      bytes: 443,
      sha256: "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b",
    },
    {
      path: "special_tokens_map.json",
      bytes: 279,
      sha256: "d5469a60db23249c7f8945013d78df30b44b6bf686c6bb4740f4223f77b1b535",
    },
    {
      path: "tokenizer.json",
      bytes: 17_098_079,
      sha256: "48564c5c7d3fa64d85d95e65414a542385f88b0f128fd8d4163fd7a57f2be05c",
    },
    {
      path: "onnx/model_quantized.onnx",
      bytes: 279_301_077,
      sha256: "dd98f3e67837d23210a6b7550c08cced4f61845b940ac45be3565840a10f3244",
    },
  ],
};

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

export type FileStatus = "ok" | "missing" | "wrong size" | "wrong hash";

/** Checks each file on disk against the manifest: size first (cheap), then the hash. */
export async function verifyWeights(
  manifest: WeightManifest,
  weightsDir: string,
): Promise<{ path: string; status: FileStatus }[]> {
  const out: { path: string; status: FileStatus }[] = [];
  for (const file of manifest.files) {
    const local = join(weightsDir, manifest.repo, file.path);
    if (!existsSync(local)) out.push({ path: file.path, status: "missing" });
    else if (statSync(local).size !== file.bytes) out.push({ path: file.path, status: "wrong size" });
    else if ((await sha256File(local)) !== file.sha256) out.push({ path: file.path, status: "wrong hash" });
    else out.push({ path: file.path, status: "ok" });
  }
  return out;
}

/**
 * Downloads every file that isn't already there and right, from the pinned revision, to a temporary name, checks
 * its size and hash, then moves it into place. A file that doesn't match is deleted and the fetch fails: a bad
 * file never sits where the reranker would load it.
 */
export async function fetchWeights(
  manifest: WeightManifest,
  weightsDir: string,
  options: { fetch?: typeof fetch; log?: (line: string) => void } = {},
): Promise<{ downloaded: string[]; kept: string[] }> {
  const { fetch: get = fetch, log = () => {} } = options;
  const downloaded: string[] = [];
  const kept: string[] = [];
  const status = new Map((await verifyWeights(manifest, weightsDir)).map((entry) => [entry.path, entry.status]));
  for (const file of manifest.files) {
    if (status.get(file.path) === "ok") {
      kept.push(file.path);
      continue;
    }
    const target = join(weightsDir, manifest.repo, file.path);
    const partial = `${target}.partial`;
    mkdirSync(dirname(target), { recursive: true });
    const url = `https://huggingface.co/${manifest.repo}/resolve/${manifest.revision}/${file.path}`;
    log(`fetching ${file.path} (${(file.bytes / 1e6).toFixed(1)} MB)`);
    const response = await get(url);
    if (!response.ok || !response.body) throw new Error(`GET ${url} answered ${response.status}`);
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(partial));
    const bytes = statSync(partial).size;
    const sha256 = await sha256File(partial);
    if (bytes !== file.bytes || sha256 !== file.sha256) {
      rmSync(partial, { force: true });
      throw new Error(`${file.path}: got ${bytes} bytes, sha256 ${sha256}; expected ${file.bytes}, ${file.sha256}`);
    }
    renameSync(partial, target);
    downloaded.push(file.path);
  }
  return { downloaded, kept };
}
