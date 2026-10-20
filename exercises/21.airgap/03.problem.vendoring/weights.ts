// 👨‍💼 An air-gapped machine can't download anything, so everything it runs is brought in beforehand: packages,
//    images and model weights, carried over on a disk. The reranker's weights are the part that fails quietly: a
//    download cut short, or one file swapped, and the model loads garbage or not at all, on a machine where you
//    can't just fetch it again.

import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join } from "node:path";
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
 * The big files' hashes are Hugging Face's LFS ids, which are sha256s of the content.
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
  // 🐨 Ask `verifyWeights` what's on disk. Then, for each file in the manifest:
  //    - "ok": push its path onto `kept`, and fetch nothing;
  //    - anything else: download it from the pinned revision,
  //      `https://huggingface.co/<repo>/resolve/<revision>/<path>`, to a temporary file beside where it goes
  //      (`<target>.partial`), check the temporary file's size and sha256 against the manifest, and only then move
  //      it to `<weightsDir>/<repo>/<path>`. On a mismatch, delete the temporary file and throw an Error that
  //      names the file. A response that isn't ok throws too. Push each downloaded path onto `downloaded`.
  //    Call `options.log` (when given) before each download, and use `options.fetch` when given, else `fetch`.
  //
  // 🐨 The classic mistake is writing straight to the target: a download that dies halfway, or a file that
  //    doesn't match, is left exactly where the reranker loads its weights. The other is checking the size alone.
  //
  // 💰 You'll need `createWriteStream`, `mkdirSync`, `renameSync`, `rmSync` from "node:fs", `dirname` from
  //    "node:path" and `Readable` from "node:stream". `mkdirSync(dir, { recursive: true })`;
  //    `await pipeline(Readable.fromWeb(response.body as never), createWriteStream(path))` writes a response to
  //    disk; `sha256File(path)` (above); `rmSync(path, { force: true })`; `renameSync(from, to)`.
  //
  // 🦉 Why a commit and not "main". The manifest pins a revision (`280bcc27...`). A branch can move: tomorrow's
  //    main may hold different files, and the sha256s here would stop matching. A commit names one set of bytes
  //    for good, which is what lets a hash check mean anything.
  // 🦉 Why a temporary name, then a rename. A rename within one folder is atomic: the file at the target is the
  //    old one or the new one, never half of either. So a cut download leaves a `.partial` behind, and the target
  //    is untouched. The reranker loads only names it knows (`onnx/model_quantized.onnx`), never `.partial`.
  // 🦉 Why the hash, and why size first. Two files can be the same size and not the same bytes. sha256 is a
  //    fingerprint: change one bit and it changes completely, and nobody knows how to make a different file with
  //    the same one. `verifyWeights` checks size first only because it's free, and hashing 279 MB takes a second.
  // 🦉 Why keep what's right. A rerun after a failure fetches only what's missing or wrong, so it's safe to run
  //    again and again, and `pnpm local:weights --check` runs the same check on an offline machine.
  //
  // 📜 https://huggingface.co/docs/hub/en/storage-backends (each big file's LFS id is its sha256)
  //
  // 🚨 The tests check the URL's pinned revision, that files already right are kept, that a wrong one is
  //    replaced, and that a short file, a same-size file with other bytes, a cut download and a 404 each fail and
  //    leave nothing at the target.
  throw new Error(
    `fetchWeights(${manifest.repo}, ${manifest.files.length} files, into ${weightsDir}${options.fetch ? ", with a fetch" : ""}) isn't written yet`,
  );
}
