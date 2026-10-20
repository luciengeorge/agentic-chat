/**
 * `pnpm vendor [--dry-run] [--out DIR] [--chat-model KEY] [--images all]`: packs what a machine with no network
 * needs to install and run the app on local models, into DIR (default `vendor/bundle`, which the repo ignores):
 *
 *   pnpm-store/      every package in pnpm-lock.yaml, fetched into a store of its own (`pnpm fetch`, run in a
 *                    scratch copy of the manifests, so this checkout's node_modules is untouched)
 *   images/          `docker save` of each image Compose needs: paradedb always; otel-lgtm and docling with
 *                    `--images all`
 *   models/          the reranker's weights (vendor/models) and LM Studio's embedding and chat models, copied
 *                    from ~/.lmstudio/models
 *   MANIFEST.json    what's in it, with sizes, and the commands to run on the offline machine
 *
 * `--dry-run` writes nothing: it measures each part where it is now and prints the sizes. Node, pnpm, Docker and
 * LM Studio themselves are installers, outside the bundle; the manifest lists them.
 *
 * The store holds this platform's native binaries (onnxruntime-node, @napi-rs/canvas, sharp) only. For another OS
 * or CPU, set pnpm's `supportedArchitectures` before vendoring.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { localConfig } from "#learn/local/config";
import { type BundlePart, bundleTotal, type ComposeConfig, composeImages, gb } from "#learn/local/vendor";
import { RERANKER_WEIGHTS } from "#learn/local/weights";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
/** Where LM Studio keeps models: downloads, and the embedding model it ships with. */
const LMSTUDIO_DIRS = [join(homedir(), ".lmstudio/models"), join(homedir(), ".lmstudio/.internal/bundled-models")];

function parseArgs(argv: string[]) {
  let dryRun = false;
  let out = join(ROOT, "vendor/bundle");
  let chatModel: string | null = localConfig().chatModel;
  let allImages = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--out") out = resolve(argv[++i] ?? "");
    else if (arg === "--chat-model") chatModel = argv[++i] || null;
    else if (arg === "--no-chat-model") chatModel = null;
    else if (arg === "--images") allImages = argv[++i] === "all";
    else throw new Error(`unknown argument ${arg}; try --dry-run, --out DIR, --chat-model KEY, --images all`);
  }
  return { dryRun, out, chatModel, allImages };
}

const run = (command: string, args: string[], cwd = ROOT) =>
  execFileSync(command, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();

/** Bytes on disk under a path, each hard-linked file once (`du`), as a store copy would take. */
function diskBytes(path: string): number {
  if (!existsSync(path)) return 0;
  return Number(run("du", ["-sk", path]).split(/\s+/)[0]) * 1024;
}

/** Every service of every profile, as Compose resolves compose.yaml. */
const composeConfig = (): ComposeConfig =>
  JSON.parse(run("docker", ["compose", "--profile", "*", "config", "--format", "json"])) as ComposeConfig;

function imageBytes(image: string): number | null {
  try {
    return Number(run("docker", ["image", "inspect", image, "--format", "{{.Size}}"]));
  } catch {
    return null;
  }
}

/** LM Studio's folder for a model key, as `lms ls --json` reports it. */
function lmStudioModel(key: string): { key: string; path: string; bytes: number } | null {
  const lms = join(homedir(), ".lmstudio/bin/lms");
  const models = JSON.parse(run(lms, ["ls", "--json"])) as { modelKey: string; path: string }[];
  const model = models.find((entry) => entry.modelKey === key);
  if (!model) return null;
  // `path` is publisher/repo[/file]; LM Studio may file the repo under another publisher folder.
  const [publisher, repo] = model.path.split("/");
  if (!repo) return null;
  for (const base of LMSTUDIO_DIRS.filter((dir) => existsSync(dir))) {
    for (const owner of [publisher, ...readdirSync(base)]) {
      const dir = join(base, owner, repo);
      if (existsSync(dir) && statSync(dir).isDirectory()) return { key, path: dir, bytes: diskBytes(dir) };
    }
  }
  return null;
}

async function main() {
  const { dryRun, out, chatModel, allImages } = parseArgs(process.argv.slice(2));
  const config = localConfig();
  const parts: BundlePart[] = [];

  parts.push({
    part: "pnpm-store",
    source: "pnpm-lock.yaml",
    bytes: diskBytes(join(ROOT, "node_modules/.pnpm")),
    note: "measured as this checkout's node_modules/.pnpm, unpacked",
  });
  for (const image of composeImages(composeConfig(), allImages)) {
    const bytes = imageBytes(image);
    const part = `images/${image.split("/").at(-1)!.replace(":", "-")}`;
    parts.push({ part, source: image, bytes, note: bytes === null ? "not pulled here" : undefined });
  }
  parts.push({
    part: `models/${RERANKER_WEIGHTS.repo}`,
    source: join(config.weightsDir, RERANKER_WEIGHTS.repo),
    bytes: diskBytes(join(config.weightsDir, RERANKER_WEIGHTS.repo)),
  });
  for (const key of [config.embeddingModel, ...(chatModel ? [chatModel] : [])]) {
    const model = lmStudioModel(key);
    parts.push({
      part: `models/lmstudio/${key}`,
      source: model?.path ?? key,
      bytes: model?.bytes ?? null,
      note: model ? undefined : "not downloaded in LM Studio: `lms get` it first",
    });
  }

  const total = bundleTotal(parts);
  for (const part of parts) {
    console.log(
      `${part.part.padEnd(52)} ${part.bytes === null ? "?".padStart(9) : gb(part.bytes).padStart(9)}${part.note ? `  (${part.note})` : ""}`,
    );
  }
  console.log(`${"total".padEnd(52)} ${gb(total).padStart(9)}`);
  if (dryRun) return;

  const free =
    Number(
      run("df", ["-k", existsSync(out) ? out : ROOT])
        .split("\n")[1]
        .split(/\s+/)[3],
    ) * 1024;
  if (free < total * 1.1) throw new Error(`${out} has ${gb(free)} free; the bundle needs about ${gb(total)}`);
  if (parts.some((part) => part.bytes === null)) throw new Error("some parts are missing here; see the list above");
  mkdirSync(out, { recursive: true });

  // The store: `pnpm fetch` in a scratch copy of the manifests, so this checkout's node_modules isn't relinked.
  const scratch = mkdtempSync(join(tmpdir(), "vendor-"));
  try {
    for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "patches"]) {
      if (existsSync(join(ROOT, file))) cpSync(join(ROOT, file), join(scratch, file), { recursive: true });
    }
    console.log("fetching the store");
    run("pnpm", ["fetch", "--store-dir", join(out, "pnpm-store")], scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  mkdirSync(join(out, "images"), { recursive: true });
  for (const part of parts.filter((entry) => entry.part.startsWith("images/"))) {
    console.log(`saving ${part.source}`);
    run("docker", ["save", "--output", join(out, `${part.part}.tar`), part.source]);
  }
  for (const part of parts.filter((entry) => entry.part.startsWith("models/"))) {
    console.log(`copying ${part.part}`);
    cpSync(part.source, join(out, part.part), { recursive: true });
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    parts: parts.map((part) => ({
      ...part,
      bytes: diskBytes(join(out, part.part.startsWith("images/") ? `${part.part}.tar` : part.part)),
    })),
    installers: ["Node 22+", "pnpm 10+", "Docker (or OrbStack)", "LM Studio"],
    offline: [
      "pnpm install --offline --frozen-lockfile --store-dir <bundle>/pnpm-store",
      "for f in <bundle>/images/*.tar; do docker load --input $f; done",
      "copy <bundle>/models/lmstudio/* into ~/.lmstudio/models/<publisher>/, and <bundle>/models/Xenova into vendor/models/",
      "pnpm local:weights --check",
    ],
  };
  writeFileSync(join(out, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const part of manifest.parts) console.log(`${part.part.padEnd(52)} ${gb(part.bytes).padStart(9)}`);
  console.log(`wrote ${out} (${gb(diskBytes(out))})`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
