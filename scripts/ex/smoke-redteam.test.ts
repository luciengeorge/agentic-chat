// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";

import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

import type { Fetch, SmokeTargets } from "./smoke";

import { DEFAULT_CORPUS_DIR } from "../../servers/fake-workspace/app";
import { checkRedteam } from "./smoke-redteam";
import { refused } from "./test-repo";

const targets = (fetch: Fetch, databaseUrl = ""): SmokeTargets => ({
  databaseUrl,
  appUrl: "http://localhost:3000",
  workspaceUrl: "http://localhost:8100",
  corpusDir: DEFAULT_CORPUS_DIR,
  fetch,
});

// The scenarios themselves, on a scripted model against a test database and an in-process fake-workspace, are
// src/core/redteam/redteam.test.ts. These cover what the smoke check adds: finding the dev world.
describe("checkRedteam", () => {
  it("says when fake-workspace isn't running", async () => {
    await expect(checkRedteam(targets(refused))).rejects.toThrow(
      "GET http://localhost:8100/health failed (ECONNREFUSED); is `pnpm fake-workspace` running?",
    );
  });

  describe.skipIf(!postgresAvailable)("on a database", () => {
    let t: TestDatabase;
    afterAll(async () => {
      await t?.drop();
    });

    it("says when the world isn't seeded", async () => {
      t = await createTestDatabase();
      const healthy: Fetch = async () => Response.json({ status: "ok" });
      await expect(checkRedteam(targets(healthy, t.url))).rejects.toThrow("no kestrel tenant; run `pnpm ex up`");
    });
  });
});
