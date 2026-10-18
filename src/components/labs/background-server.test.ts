// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Tx } from "@/db/tenant";

import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

import { act, type BackgroundLabDeps, board } from "./background-server";

describe.skipIf(!postgresAvailable)("the background lab", () => {
  let t: TestDatabase;
  let kestrel: string;
  let harbour: string;
  let deps: BackgroundLabDeps;

  const classesOf = async (tenantId: string, claimed: { job: string | null }[]) => {
    const jobs = (await board(deps, tenantId)).jobs;
    return claimed.map(({ job }) => jobs.find((j) => j.id === job)?.class ?? null);
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    [{ id: kestrel }, { id: harbour }] = await t.sql`
      INSERT INTO organization (name, slug, created_at)
      VALUES ('Kestrel Pay', 'kestrel', now()), ('Harbour Health', 'harbour', now())
      RETURNING id`;
    deps = {
      withTenant: <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) => withTenantOn(t.appDb, tenantId, fn),
      owner: t.db,
    };
  });

  afterAll(async () => {
    await t?.drop();
  });

  beforeEach(async () => {
    await act(deps, kestrel, "clear", false);
  });

  it("lets the backfill take both workers without a cap, and the delta waits", async () => {
    await act(deps, kestrel, "backfill", false);
    await act(deps, kestrel, "delta", false);
    const { claimed } = await act(deps, kestrel, "claim", false);
    expect(await classesOf(kestrel, claimed)).toEqual(["backfill", "backfill"]);
    const { jobs } = await board(deps, kestrel);
    expect(jobs.map((job) => job.label).slice(0, 2)).toEqual(["pages 1 to 250", "pages 251 to 500"]);
    expect(jobs.at(-1)).toMatchObject({ class: "incremental", state: "queued" });
  });

  it("gives the delta the second worker with backfill capped at 1, and claims again only for idle workers", async () => {
    await act(deps, kestrel, "backfill", true);
    await act(deps, kestrel, "delta", true);
    const { claimed } = await act(deps, kestrel, "claim", true);
    expect(await classesOf(kestrel, claimed)).toEqual(["backfill", "incremental"]);
    expect((await act(deps, kestrel, "claim", true)).claimed).toEqual([]);
    await act(deps, kestrel, "finish", true);
    const again = await act(deps, kestrel, "claim", true);
    expect(await classesOf(kestrel, again.claimed)).toEqual(["backfill", null]);
  });

  it("counts jobs by queue, class and state for the viewer's tenant only", async () => {
    await act(deps, kestrel, "backfill", false);
    await act(deps, kestrel, "claim", false);
    const cells = (await board(deps, kestrel)).cells.map((cell) => [cell.class, cell.state, cell.jobs]);
    expect(cells).toEqual([
      ["backfill", "queued", 10],
      ["backfill", "running", 2],
    ]);
    expect((await board(deps, harbour)).cells).toEqual([]);
    expect((await board(deps, harbour)).outbox).toEqual({ pending: 0, published: 0, claimed: 0, failed: 0 });
  });
});
