// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";
import { loadWorld } from "@/fixtures/world";
import { DEV_SECRETS } from "@/lib/auth-env";

import type { Runtime } from "../../servers/fake-workspace/app";
import type { Fetch, SmokeTargets } from "./smoke";

import { DEFAULT_CORPUS_DIR, createApp } from "../../servers/fake-workspace/app";
import { CONTROL_HEADER, DEV_CONTROL_TOKEN } from "../../servers/fake-workspace/control";
import { checkBannedUser, checkFakeWorkspace, checkParadeDb, checkSignIn, checkSpikeWorkflow } from "./smoke";
import { refused } from "./test-repo";

const APP_URL = "http://localhost:3000";
const WORKSPACE_URL = "http://localhost:8100";
const world = loadWorld();

function targets(fetch: Fetch): SmokeTargets {
  return { databaseUrl: "", appUrl: APP_URL, workspaceUrl: WORKSPACE_URL, corpusDir: DEFAULT_CORPUS_DIR, fetch };
}

describe("checkParadeDb", () => {
  it("says where nothing answers", async () => {
    await expect(checkParadeDb("postgres://ac:ac@127.0.0.1:1/ac")).rejects.toThrow(
      "nothing answers at 127.0.0.1:1; `pnpm ex up` starts ParadeDB",
    );
  });

  describe.skipIf(!postgresAvailable)("on a database", () => {
    const databases: TestDatabase[] = [];
    afterAll(async () => {
      for (const t of databases) await t.drop();
    });
    const database = async (options?: { migrated: boolean }) => {
      const t = await createTestDatabase(options);
      databases.push(t);
      return t;
    };

    it("runs a BM25 and a nearest-neighbour query, and leaves nothing behind", async () => {
      const t = await database();
      expect(await checkParadeDb(t.url)).toMatch(
        /^pg_search \d+\.\d+\.\d+, vector \d+\.\d+\.\d+; BM25 and nearest neighbour both found row 2$/,
      );
      expect(await t.sql`SELECT to_regclass('ex_smoke_probe')::text AS probe`).toEqual([{ probe: null }]);
    });

    it("fails without pg_search and vector", async () => {
      const t = await database({ migrated: false });
      await t.sql`DROP EXTENSION pg_search, vector`;
      await expect(checkParadeDb(t.url)).rejects.toThrow(
        "pg_search and vector missing; `pnpm db:migrate` creates them",
      );
    });
  });
});

describe("sign-in checks", () => {
  it("say when the app isn't running", async () => {
    const message = "POST http://localhost:3000/api/auth/sign-in/email failed (ECONNREFUSED); is `pnpm dev` running?";
    await expect(checkSignIn(targets(refused))).rejects.toThrow(message);
    await expect(checkBannedUser(targets(refused))).rejects.toThrow(message);
  });

  describe.skipIf(!postgresAvailable)("against better-auth on the seeded world", () => {
    let t: TestDatabase;
    let app: Fetch;
    const ids = {
      leo: world.userId("kestrel", "leo.martin"),
      nina: world.userId("harbour", "nina.osei"),
      peter: world.userId("kestrel", "peter.hall"),
    };

    /** Runs `change` in the seeded database, then `undo` once the test is done with it. */
    async function changed(change: string, undo: string, test: () => Promise<void>) {
      await t.sql.unsafe(change);
      try {
        await test();
      } finally {
        await t.sql.unsafe(undo);
      }
    }

    beforeAll(async () => {
      t = await createTestDatabase();
      // The db and auth modules read these at import, so they bind to this test's database.
      Object.assign(process.env, {
        DATABASE_URL: t.url,
        AC_ENV: "test",
        BETTER_AUTH_SECRET: DEV_SECRETS.BETTER_AUTH_SECRET,
        BETTER_AUTH_URL: APP_URL,
      });
      const { auth } = await import("@/lib/auth");
      const { getViewer } = await import("@/lib/auth-server");
      await (await import("@/db/seed")).seedWorld(world);
      // The two routes the checks call, as src/routes/api/auth/$.ts and src/routes/api/me.ts serve them.
      app = async (url, init) => {
        const request = new Request(url, init);
        const { pathname } = new URL(url);
        if (pathname.startsWith("/api/auth/")) return auth.handler(request);
        if (pathname !== "/api/me") return new Response("Not Found", { status: 404 });
        try {
          return Response.json(await getViewer(request.headers));
        } catch (error) {
          if (error instanceof Response) return error;
          throw error;
        }
      };
    }, 60_000);

    afterAll(async () => {
      if (!t) return;
      const { db } = await import("@/db/client");
      await db.$client.end();
      await t.drop();
    });

    it("sign leo.martin and nina.osei in, find their tenants, and sign them out", async () => {
      expect(await checkSignIn(targets(app))).toBe("leo.martin -> kestrel, nina.osei -> harbour");
      expect(
        await t.sql`SELECT count(*)::int AS n FROM session WHERE user_id IN ${t.sql([ids.leo, ids.nina])}`,
      ).toEqual([{ n: 0 }]);
    });

    it("fail when a user's tenant is wrong", async () => {
      await changed(
        `UPDATE member SET organization_id = (SELECT id FROM organization WHERE slug = 'kestrel') WHERE user_id = '${ids.nina}'`,
        `UPDATE member SET organization_id = (SELECT id FROM organization WHERE slug = 'harbour') WHERE user_id = '${ids.nina}'`,
        () =>
          expect(checkSignIn(targets(app))).rejects.toThrow("nina.osei's /api/me says tenant kestrel, want harbour"),
      );
    });

    it("fail when a user's id isn't the world's", async () => {
      const renamed: Fetch = async (url, init) => {
        const response = await app(url, init);
        if (!url.endsWith("/api/me")) return response;
        return Response.json({ ...(await response.json()), userId: "00000000-0000-0000-0000-000000000000" });
      };
      await expect(checkSignIn(targets(renamed))).rejects.toThrow(
        `leo.martin has id 00000000-0000-0000-0000-000000000000, not the world's ${ids.leo}`,
      );
    });

    it("refuse peter.hall for his ban", async () => {
      expect(await checkBannedUser(targets(app))).toBe("peter.hall: 403 BANNED_USER");
    });

    it("fail when peter.hall isn't banned", async () => {
      await changed(
        `UPDATE "user" SET banned = false WHERE id = '${ids.peter}'`,
        `UPDATE "user" SET banned = true WHERE id = '${ids.peter}'; DELETE FROM session WHERE user_id = '${ids.peter}'`,
        () => expect(checkBannedUser(targets(app))).rejects.toThrow("peter.hall signed in; `pnpm db:seed` bans him"),
      );
    });

    it("fail when peter.hall is refused for another reason than his ban", async () => {
      await changed(
        `UPDATE "user" SET email = 'gone@kestrelpay.example' WHERE id = '${ids.peter}'`,
        `UPDATE "user" SET email = 'peter.hall@kestrelpay.example' WHERE id = '${ids.peter}'`,
        () =>
          expect(checkBannedUser(targets(app))).rejects.toThrow(
            "peter.hall was refused with 401 INVALID_EMAIL_OR_PASSWORD, want 403 BANNED_USER",
          ),
      );
    });
  });
});

describe("checkFakeWorkspace", () => {
  const runtimes: Runtime[] = [];
  let tmp: string | null = null;
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.notifier.close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  /** fake-workspace in this process, on the committed corpus unless told otherwise. */
  function workspace(corpusDir?: string) {
    const { app, runtime } = createApp({ corpusDir });
    runtimes.push(runtime);
    const fetch: Fetch = async (url, init) => app.fetch(new Request(url, init));
    return fetch;
  }

  /** Lets `edit` rewrite the JSON of every response to a path matching `pattern`. */
  function tamper(fetch: Fetch, pattern: RegExp, edit: (body: Record<string, any>) => unknown): Fetch {
    return async (url, init) => {
      const response = await fetch(url, init);
      if (!pattern.test(new URL(url).pathname)) return response;
      return Response.json(edit(await response.json()), { status: response.status });
    };
  }

  const memo = "4fb87666-e50a-5a81-a13f-2d9773b584b1";
  const exec = world.groupId("kestrel", "/Kestrel/Exec");
  const members = /\/transitiveMembers$/;
  const user = (username: string) => ({
    "@odata.type": "#microsoft.graph.user",
    id: world.userId("kestrel", username),
  });

  it("passes on the committed corpus", async () => {
    expect(await checkFakeWorkspace(targets(workspace()))).toBe(
      "/Exec/Project Heron Board Memo.pdf: write to /Kestrel/Exec only; Harbour's token: 403; " +
        "/Kestrel/Exec reaches daniel.reyes, not leo.martin",
    );
  });

  it("follows the member pages", async () => {
    const fetch = workspace();
    const paged: Fetch = (url, init) => {
      const next = new URL(url);
      if (members.test(next.pathname) && !next.searchParams.has("$top")) next.searchParams.set("$top", "1");
      return fetch(next.toString(), init);
    };
    await expect(checkFakeWorkspace(targets(paged))).resolves.toContain("reaches daniel.reyes, not leo.martin");
  });

  it("fails without the corpus", async () => {
    tmp = mkdtempSync(join(tmpdir(), "smoke-corpus-"));
    await expect(checkFakeWorkspace(targets(workspace(tmp)))).rejects.toThrow(
      "fake-workspace runs without its corpus; check AC_CORPUS_DIR",
    );
  });

  it("fails when the memo is shared with anyone else", async () => {
    const fetch = workspace();
    const finance = world.groupId("kestrel", "/Kestrel/Finance");
    const shared = await fetch(`${WORKSPACE_URL}/_control/sites/kestrel/items/${memo}/sharing`, {
      method: "PUT",
      headers: { "content-type": "application/json", [CONTROL_HEADER]: DEV_CONTROL_TOKEN },
      body: JSON.stringify({
        inherit: true,
        grants: [{ principal_type: "group", principal_id: finance, principal_name: "/Kestrel/Finance", role: "read" }],
      }),
    });
    expect(shared.status).toBe(200);
    await expect(checkFakeWorkspace(targets(fetch))).rejects.toThrow(
      `/Exec/Project Heron Board Memo.pdf has grants [write ${exec}, read ${finance}], want only write to /Kestrel/Exec`,
    );
  });

  it("fails when Harbour's token opens Kestrel's site", async () => {
    const real = workspace();
    const fetch: Fetch = async (url, init) =>
      url.endsWith("/sites/kestrel/drive/root") ? Response.json({}) : real(url, init);
    await expect(checkFakeWorkspace(targets(fetch))).rejects.toThrow(
      "Harbour's token on Kestrel's site got 200, want 403",
    );
  });

  it("fails when /Kestrel/Exec reaches leo.martin, or misses daniel.reyes", async () => {
    const withLeo = tamper(workspace(), members, (page) => ({ ...page, value: [...page.value, user("leo.martin")] }));
    await expect(checkFakeWorkspace(targets(withLeo))).rejects.toThrow("/Kestrel/Exec reaches leo.martin");
    const daniel = world.userId("kestrel", "daniel.reyes");
    const withoutDaniel = tamper(workspace(), members, (page) => ({
      ...page,
      value: page.value.filter((member: { id: string }) => member.id !== daniel),
    }));
    await expect(checkFakeWorkspace(targets(withoutDaniel))).rejects.toThrow(
      "/Kestrel/Exec doesn't reach daniel.reyes",
    );
  });

  it("says when fake-workspace isn't running", async () => {
    await expect(checkFakeWorkspace(targets(refused))).rejects.toThrow(
      "GET http://localhost:8100/health failed (ECONNREFUSED); is `pnpm fake-workspace` running?",
    );
  });
});

type FakeSpike = {
  /** False: the run completes as soon as it's resumed. */
  sleeps?: boolean;
  /** The resume that finds the hook; earlier ones get 404, as when start() returns before the run registers it. */
  hookOnAttempt?: number;
  ends?: "completed" | "failed";
  chunks?: (note: string) => string[];
};

/** The spike routes (src/routes/api/spike) over in-memory runs. */
function fakeSpike({
  sleeps = true,
  hookOnAttempt = 2,
  ends = "completed",
  chunks = (note) => ["resumed", note, "done"],
}: FakeSpike = {}): Fetch {
  type Run = { token: string; sleepMs: number; attempts: number; resumedAt: number | null; note: string };
  const runs = new Map<string, Run>();
  const status = (run: Run) =>
    run.resumedAt === null || Date.now() < run.resumedAt + (sleeps ? run.sleepMs : 0) ? "running" : ends;

  return async (url, init = {}) => {
    const { pathname } = new URL(url);
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (init.method === "POST" && pathname === "/api/spike") {
      if (!Number.isInteger(body.sleepMs)) return Response.json({ error: "sleepMs" }, { status: 400 });
      const runId = `wrun_${runs.size + 1}`;
      runs.set(runId, { token: `spike:${runId}`, sleepMs: body.sleepMs, attempts: 0, resumedAt: null, note: "" });
      return Response.json({ runId, token: `spike:${runId}` });
    }
    if (init.method === "POST" && pathname === "/api/spike/resume") {
      const entry = [...runs].find(([, run]) => run.token === body.token);
      if (!entry || ++entry[1].attempts < hookOnAttempt) {
        return Response.json({ error: "hook not found" }, { status: 404 });
      }
      Object.assign(entry[1], { resumedAt: Date.now(), note: body.note });
      return Response.json({ runId: entry[0] });
    }
    const [, runId, stream] = /^\/api\/spike\/([^/]+)(\/stream)?$/.exec(pathname) ?? [];
    const run = runId === undefined ? undefined : runs.get(runId);
    if (!run) return Response.json({ error: "run not found" }, { status: 404 });
    if (!stream) return Response.json({ runId, status: status(run) });
    // Open until the run completes, like the run's real stream.
    const lines = new ReadableStream<Uint8Array>({
      async start(controller) {
        while (status(run) !== "completed") {
          if (init.signal?.aborted) return controller.error(init.signal.reason);
          await new Promise((done) => setTimeout(done, 5));
        }
        const text = chunks(run.note).map((chunk, index) => JSON.stringify({ type: "chunk", index, text: chunk }));
        controller.enqueue(new TextEncoder().encode(`${text.join("\n")}\n`));
        controller.close();
      },
    });
    return new Response(lines, { headers: { "content-type": "application/x-ndjson" } });
  };
}

describe("checkSpikeWorkflow", () => {
  const fast = { sleepMs: 50, pollMs: 5, timeoutMs: 2000 };

  it("starts the run, resumes its hook once it's there, waits out the sleep and reads the stream", async () => {
    expect(await checkSpikeWorkflow(targets(fakeSpike()), fast)).toBe(
      "run wrun_1: resumed (attempt 2), slept 50 ms, streamed 3 chunks, completed",
    );
  });

  it("fails when the run completes inside its sleep", async () => {
    await expect(checkSpikeWorkflow(targets(fakeSpike({ sleeps: false })), fast)).rejects.toThrow(
      /^run wrun_1 completed \d+ ms after the resume, inside its sleep$/,
    );
  });

  it("fails when the run fails", async () => {
    await expect(checkSpikeWorkflow(targets(fakeSpike({ ends: "failed" })), fast)).rejects.toThrow(
      "run wrun_1 ended failed",
    );
  });

  it("fails when the stream misses the resume's note", async () => {
    const fetch = fakeSpike({ chunks: () => ["resumed", "done"] });
    await expect(checkSpikeWorkflow(targets(fetch), fast)).rejects.toThrow(
      "the stream carried [resumed, done], want [resumed, smoke-wrun_1, done]",
    );
  });

  it("gives up when the hook never shows up", async () => {
    const fetch = fakeSpike({ hookOnAttempt: Infinity });
    await expect(checkSpikeWorkflow(targets(fetch), { ...fast, timeoutMs: 100 })).rejects.toThrow(
      "gave up after 0.1 s waiting for the run's hook",
    );
  });

  it("says when the app isn't running", async () => {
    await expect(checkSpikeWorkflow(targets(refused), fast)).rejects.toThrow(
      "POST http://localhost:3000/api/spike failed (ECONNREFUSED); is `pnpm dev` running?",
    );
  });
});
