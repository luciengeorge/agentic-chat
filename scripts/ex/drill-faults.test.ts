// @vitest-environment node
// Section 20's five faults, each planted for real in a copy of this repo: git sees nothing, the fault's own
// test fails while it's in and passes on the reference, and the faulty code still formats, lints and typechecks,
// so no tool points at it. Slow (a Vitest per drill and leg, and one typecheck): about two minutes.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Fault } from "@/core/drills/types";

import { DRILLS } from "@/core/drills/catalog";
import { unseal } from "@/core/drills/seal";
import { createTestDatabase, postgresAvailable } from "@/db/testing";

import type { DrillDeps } from "./drill";
import type { SlotSwitch } from "./switch";

import { main } from "./cli";
import { defaultDrillDeps, prepareFiles, restoreFiles, runDrillTest, writeFaults } from "./drill";
import { createLive } from "./drill-live";
import { copyRepo, gitIn } from "./drill-testing";
import { envWithoutVitest } from "./test-repo";

const faults = DRILLS.map((drill) => ({ id: drill.id, fault: unseal<Fault>(drill.id, drill.sealed) }));
const SLOW = { timeout: 240_000 };

describe.skipIf(!postgresAvailable)("the drills' faults, planted in a copy of the repo", () => {
  let root: string;
  let cleanup = () => {};

  beforeAll(() => {
    ({ root, cleanup } = copyRepo());
  }, 60_000);
  afterAll(() => cleanup());

  const test = (id: string, source: string) =>
    runDrillTest(root, id, source, { project: "app", env: envWithoutVitest() });

  it.each(faults)(
    "$id: hidden from git, fails its test while planted, passes once reset",
    SLOW,
    async ({ id, fault }) => {
      const prepared = prepareFiles(root, fault);
      const times = () => fault.files.map((file) => Math.round(statSync(join(root, file.path)).mtimeMs));
      const before = times();
      writeFaults(root, prepared);
      try {
        expect(gitIn(root, ["status", "--porcelain"]), "git status").toBe("");
        expect(gitIn(root, ["diff", "HEAD"]), "git diff HEAD").toBe("");
        expect(times(), "the files' modification times").toEqual(before);
        for (const file of fault.files) {
          expect(readFileSync(join(root, file.path), "utf8")).not.toBe(
            prepared.find((p) => p.saved.path === file.path)!.saved.original,
          );
        }
        const planted = await test(id, fault.test);
        expect(planted.error, "the test file loads").toBeNull();
        expect(
          planted.tests.some((t) => t.outcome === "failed"),
          `${id}'s test with the fault planted: ${JSON.stringify(planted.tests)}`,
        ).toBe(true);
      } finally {
        restoreFiles(
          root,
          prepared.map((p) => p.saved),
        );
      }
      expect(gitIn(root, ["ls-files", "-v", ...fault.files.map((file) => file.path)]).match(/^S/m)).toBeNull();
      const reference = await test(id, fault.test);
      expect(reference.passed, `${id}'s test on the reference: ${JSON.stringify(reference)}`).toBe(true);
    },
  );

  it("leaves code that formats, lints and typechecks, all five planted at once", SLOW, () => {
    const prepared = faults.flatMap(({ fault }) => prepareFiles(root, fault));
    writeFaults(root, prepared);
    try {
      const files = prepared.map((p) => p.saved.path);
      const bin = (name: string) => join(root, "node_modules/.bin", name);
      const run = (command: string, args: string[]) =>
        execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      run(bin("oxfmt"), ["--check", ...files]);
      run(bin("oxlint"), ["--deny-warnings", ...files]);
      run(bin("tsgo"), ["--noEmit"]);
    } finally {
      restoreFiles(
        root,
        prepared.map((p) => p.saved),
      );
    }
  });

  it(
    "stuck-edits end to end through `ex drill`, on a test database: plant, check, fix, check, reset",
    SLOW,
    async () => {
      const t = await createTestDatabase();
      try {
        await t.sql`INSERT INTO organization (name, slug, created_at) VALUES ('Kestrel Pay', 'kestrel', now())`;
        const env = { DATABASE_ADMIN_URL: t.url, DATABASE_URL: t.appUrl };
        const deps: DrillDeps = {
          ...defaultDrillDeps(),
          live: () => createLive({ env }),
          runTest: (_root, id, source) => test(id, source),
        };
        const noServer: SlotSwitch = { pauseDevServer: async () => null, cancelOpenRuns: async () => [] };
        const ex = async (...args: string[]) => {
          let out = "";
          const code = await main([...args, "--json"], {
            root,
            io: { out: (text) => (out += text), err: (text) => (out += text) },
            slotSwitch: noServer,
            drills: deps,
          });
          return { code, body: JSON.parse(out) };
        };
        const poison = () => t.sql`SELECT failed_at FROM outbox WHERE payload ? 'Mode'`;

        const planted = await ex("drill", "stuck-edits");
        expect(planted.code, JSON.stringify(planted.body)).toBe(0);
        expect(planted.body.symptom).toContain("changes made in Kestrel's SharePoint stopped reaching the assistant");
        expect(gitIn(root, ["status", "--porcelain"])).toBe("");
        expect(await poison()).toHaveLength(1);

        const broken = await ex("drill", "check");
        expect(broken.code).toBe(1);
        expect(broken.body.symptom.gone).toBe(false);
        expect(broken.body.test.passed).toBe(false);

        // The learner's fix, deployed, and the relay giving up on the poison (no dev server runs it here).
        const { fault } = faults.find((entry) => entry.id === "stuck-edits")!;
        for (const file of fault.files)
          writeFileSync(join(root, file.path), gitIn(root, ["show", `HEAD:${file.path}`]));
        await t.sql`UPDATE outbox SET failed_at = now() WHERE payload ? 'Mode'`;
        const fixed = await ex("drill", "check");
        expect(fixed.body, JSON.stringify(fixed.body)).toMatchObject({ passed: true, symptom: { gone: true } });

        expect((await ex("drill", "reset")).body).toMatchObject({
          drill: "stuck-edits",
          restored: 2,
          undone: 1,
          failures: [],
        });
        expect(await poison()).toHaveLength(0);
        expect(gitIn(root, ["ls-files", "-v"]).match(/^S/m)).toBeNull();
        expect(gitIn(root, ["status", "--porcelain"])).toBe("");
        expect(
          (await ex("drill", "list")).body.drills.find((row: { id: string }) => row.id === "stuck-edits").status,
        ).toBe("passed");
      } finally {
        await t.drop();
      }
    },
  );
});
