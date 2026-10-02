// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Run } from "./process";

import { cancelLocalRuns, CancelSkipped } from "./switch";

type Status = "pending" | "running" | "completed" | "cancelled";

/** The workflow CLI over a table of runs, a page of one run at a time. */
function fakeCli(runs: Record<string, Status>, { endsBeforeCancel = [] as string[], stuck = [] as string[] } = {}) {
  const calls: string[][] = [];
  const run: Run = async (command, args, { env }) => {
    calls.push(args);
    seen.push(env ?? {});
    expect(command).toMatch(/node_modules\/\.bin\/workflow$/);
    expect(args.slice(-2)).toEqual(["--backend", "local"]);
    expect(env?.WORKFLOW_LOCAL_DATA_DIR).toBeDefined();
    const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
    if (args[0] === "inspect") {
      const matching = Object.keys(runs).filter((id) => runs[id] === flag("--status"));
      const at = Number(flag("--cursor") ?? 0);
      const page = {
        data: matching.slice(at, at + 1).map((runId) => ({ runId })),
        cursor: String(at + 1),
        hasMore: at + 1 < matching.length,
      };
      return { code: 0, stdout: JSON.stringify(page), stderr: "" };
    }
    const id = args[1]!;
    if (endsBeforeCancel.includes(id)) runs[id] = "completed";
    if (stuck.includes(id) || runs[id] === "completed") return { code: 1, stdout: "", stderr: `can't cancel ${id}` };
    runs[id] = "cancelled";
    return { code: 0, stdout: `Cancelled run ${id}\n`, stderr: "" };
  };
  return { run, calls };
}

let root: string;
/** The environment each workflow CLI call ran with. */
let seen: NodeJS.ProcessEnv[] = [];
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  seen = [];
});

function setup({ data = true } = {}) {
  root = mkdtempSync(join(tmpdir(), "ex-cancel-"));
  const dir = join(root, "runs");
  if (data) mkdirSync(dir);
  return { AC_ENV: "dev", WORKFLOW_LOCAL_DATA_DIR: dir };
}

describe("cancelLocalRuns", () => {
  it("cancels every pending and running run, page by page", async () => {
    const env = setup();
    const runs: Record<string, Status> = { a: "pending", b: "running", c: "running", d: "completed" };
    const { run, calls } = fakeCli(runs);
    expect(await cancelLocalRuns(root, { run, env })).toEqual(["a", "b", "c"]);
    expect(runs).toEqual({ a: "cancelled", b: "cancelled", c: "cancelled", d: "completed" });
    expect(calls.filter((args) => args[0] === "inspect" && args.includes("--cursor"))).toHaveLength(1);
  });

  it("reads the dev server's .env.local, under the environment it's given", async () => {
    setup({ data: false });
    mkdirSync(join(root, "custom-runs"));
    writeFileSync(join(root, ".env.local"), "AC_ENV=dev\nWORKFLOW_LOCAL_DATA_DIR=custom-runs\n");
    const { run, calls } = fakeCli({ a: "running" });
    expect(await cancelLocalRuns(root, { run, env: {} })).toEqual(["a"]);
    expect(calls.at(-1)).toEqual(["cancel", "a", "--backend", "local"]);
    expect(seen.at(-1)?.WORKFLOW_LOCAL_DATA_DIR).toBe("custom-runs");
    // A variable set in the environment wins over the file, as with dotenv-cli.
    await expect(cancelLocalRuns(root, { run, env: { AC_ENV: "test" } })).rejects.toThrow(
      new CancelSkipped("AC_ENV is test, not dev"),
    );
  });

  it("is skipped outside dev, and has nothing to do without local run data", async () => {
    const { run, calls } = fakeCli({ a: "running" });
    await expect(cancelLocalRuns(root, { run, env: { ...setup(), AC_ENV: "test" } })).rejects.toThrow(
      new CancelSkipped("AC_ENV is test, not dev"),
    );
    rmSync(root, { recursive: true, force: true });
    expect(await cancelLocalRuns(root, { run, env: setup({ data: false }) })).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("lets a run that ended on its own go, and fails on one that stays open", async () => {
    const env = setup();
    const ended = fakeCli({ a: "running", b: "running" }, { endsBeforeCancel: ["a"] });
    expect(await cancelLocalRuns(root, { run: ended.run, env })).toEqual(["b"]);

    const stuck = fakeCli({ a: "running" }, { stuck: ["a"] });
    await expect(cancelLocalRuns(root, { run: stuck.run, env })).rejects.toMatchObject({
      message: "workflow cancel a failed",
      detail: "can't cancel a",
    });
  });
});
