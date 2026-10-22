// @vitest-environment node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Recorder, RecordDeps } from "./record";

import { main } from "./cli";
import { RECORDERS, secretIn, UNRECORDED } from "./record";
import { defaultSlotSwitch } from "./switch";

/** A recorder that runs node to write `files` (path -> text) and exit with `code`, and notes that it ran. */
function fake(name: string, files: Record<string, string>, { paid = false, code = 0 } = {}): Recorder {
  const script =
    `const fs = require("node:fs"); fs.appendFileSync("ran.txt", ${JSON.stringify(`${name}\n`)});` +
    Object.entries(files)
      .map(([path, text]) => `fs.writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(text)});`)
      .join("") +
    `process.exit(${code});`;
  return {
    name,
    title: `the ${name} recording`,
    command: [process.execPath, "-e", script],
    writes: ["rec"],
    calls: paid ? ["OpenAI"] : [],
    cost: paid ? "about $0.01" : "$0",
    needs: [],
    next: [`pnpm test ${name}`],
  };
}

const KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
});

function setup(recorders: Recorder[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ex-record-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "rec"));
  writeFileSync(join(root, "rec/old.json"), '{"recorded": "before"}\n');
  const deps: RecordDeps = {
    recorders,
    unrecorded: [{ name: "model", files: ["rec/model"], why: "recorded once by a script that isn't committed" }],
    env: { OPENAI_API_KEY: KEY },
  };
  const read = (rel: string) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), "utf8") : null);

  async function ex(args: string[], { ok = true, json = true } = {}) {
    let out = "";
    let err = "";
    const code = await main(json ? ["record", ...args, "--json"] : ["record", ...args], {
      root,
      io: { out: (text) => (out += `${text}\n`), err: (text) => (err += `${text}\n`) },
      slotSwitch: defaultSlotSwitch,
      recorders: deps,
    });
    expect(code === 0, `exit ${code}\n${out}${err}`).toBe(ok);
    return json ? JSON.parse(out) : { out, err };
  }
  return { root, read, ex };
}

describe("ex record", () => {
  it("lists every recorder, what it costs and what it can't refresh, and runs nothing", async () => {
    const { ex, read } = setup([fake("judge", { "rec/judge.json": "{}" }, { paid: true })]);
    const out = await ex([]);
    expect(out).toMatchObject({
      dry_run: true,
      recorders: [{ name: "judge", status: "planned", calls: ["OpenAI"], cost: "about $0.01", writes: ["rec"] }],
      unrecorded: [{ name: "model", why: "recorded once by a script that isn't committed" }],
    });
    expect(read("ran.txt")).toBeNull();
    expect((await ex(["--all", "--dry-run"])).recorders[0].status).toBe("planned");
    expect(read("ran.txt")).toBeNull();
  });

  it("won't call a paid API without --yes, and says what it would cost", async () => {
    const { ex, read } = setup([fake("judge", { "rec/judge.json": "{}" }, { paid: true })]);
    expect(await ex(["judge"], { ok: false })).toEqual({
      error: "judge calls paid APIs; run again with --yes to spend it",
      detail: "judge: OpenAI; about $0.01",
    });
    expect(read("ran.txt")).toBeNull();
    const out = await ex(["judge", "--yes"]);
    expect(out.recorders).toMatchObject([{ name: "judge", status: "recorded", changed: ["rec/judge.json"] }]);
    expect(out.next).toEqual(["pnpm test judge"]);
  });

  it("runs a recorder that calls nothing paid without --yes, and says which tests to run after", async () => {
    const { ex, read } = setup([fake("ocr", { "rec/old.json": '{"recorded": "after"}\n' })]);
    const { out } = await ex(["ocr"], { json: false });
    expect(read("rec/old.json")).toBe('{"recorded": "after"}\n');
    expect(out).toContain("✓ ocr");
    expect(out).toContain("    rec/old.json");
    expect(out).toContain("then run:\n  pnpm test ocr");
  });

  it.each([
    ["a bearer token", "Authorization: Bearer abc.def"],
    ["the key from the environment", `{"key": "${KEY}"}`],
    ["an OpenAI-shaped key", '{"key": "sk-other0123456789abcdefghij"}'],
  ])("refuses a recording holding %s and puts the old files back", async (_, text) => {
    const { ex, read } = setup([
      fake("leaky", { "rec/old.json": text, "rec/new.json": "{}" }),
      fake("later", { "rec/later.json": "{}" }),
    ]);
    const out = await ex(["--all", "--yes"], { ok: false });
    expect(out.recorders).toMatchObject([
      { name: "leaky", status: "refused", changed: [], reason: expect.stringMatching(/^rec\/old\.json holds /) },
      { name: "later", status: "not run" },
    ]);
    expect(read("rec/old.json")).toBe('{"recorded": "before"}\n');
    expect(read("rec/new.json")).toBeNull();
    expect(read("ran.txt")).toBe("leaky\n");
  });

  it("puts the files back when a recorder fails, and stops there", async () => {
    const { ex, read } = setup([
      fake("broken", { "rec/old.json": "half" }, { code: 3 }),
      fake("later", { "rec/later.json": "{}" }),
    ]);
    const out = await ex(["--all"], { ok: false });
    expect(out.recorders).toMatchObject([
      { name: "broken", status: "failed", reason: expect.stringContaining("exited 3; its files are as they were") },
      { name: "later", status: "not run" },
    ]);
    expect(read("rec/old.json")).toBe('{"recorded": "before"}\n');
  });

  it("names what it can't refresh, and refuses a name it doesn't know", async () => {
    const { ex } = setup([fake("ocr", {})]);
    expect((await ex(["model"], { ok: false })).error).toBe(
      "ex record can't refresh model: recorded once by a script that isn't committed",
    );
    expect(await ex(["nope"], { ok: false })).toEqual({ error: "no recorder named nope", detail: "recorders: ocr" });
    expect((await ex(["ocr", "--all"], { ok: false })).error).toBe("record takes a name or --all, not both");
  });
});

describe("the repo's recorders", () => {
  it("each name a committed script, and only the eval and vectors ones call a paid API", () => {
    const root = join(import.meta.dirname, "../..");
    const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts as Record<string, string>;
    for (const { command } of RECORDERS) {
      const [, ...args] = command;
      const target = args[0] === "exec" ? args.at(-1)! : scripts[args[0]!];
      expect(target, command.join(" ")).toBeTruthy();
      if (args[0] === "exec") expect(existsSync(join(root, target!))).toBe(true);
    }
    expect(RECORDERS.filter((r) => r.calls.length).map((r) => r.name)).toEqual(["eval", "vectors"]);
    for (const { files } of UNRECORDED) for (const file of files) expect(existsSync(join(root, file)), file).toBe(true);
  });

  it("are clean today: no committed recording holds a bearer token or a key", () => {
    const root = join(import.meta.dirname, "../..");
    const walk = (path: string): string[] =>
      !existsSync(path)
        ? []
        : statSync(path).isDirectory()
          ? readdirSync(path).flatMap((entry) => walk(join(path, entry)))
          : [readFileSync(path, "latin1")];
    const paths = [...RECORDERS.flatMap((r) => r.writes), ...UNRECORDED.flatMap((u) => u.files)];
    for (const path of paths) for (const text of walk(join(root, path))) expect(secretIn(text, {})).toBeNull();
  });
});
