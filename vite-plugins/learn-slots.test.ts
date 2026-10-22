// @vitest-environment node
import type { AddressInfo } from "node:net";
import type { Plugin, ViteDevServer } from "vite";

import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createLogger, createServer } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { pauseDevServer } from "../scripts/ex/dev-server";
import { run } from "../scripts/ex/process";
import { envWithoutVitest, makeRepo, readme } from "../scripts/ex/test-repo";
import {
  createSlotResolver,
  DEV_SERVER_FILE,
  type DevServerEntry,
  learnSlots,
  learnSlotsEsbuild,
  readDevServerEntry,
  SlotError,
} from "./learn-slots";

const VITEST = join(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs");

const STEP = {
  "src/core/_sample/greeting.ts": "export const formatGreeting = (name: string) => `hello ${name}`;\n",
  "src/core/_sample/farewell.ts": "export const formatFarewell = (name: string) => `bye ${name}`;\n",
  "exercises/_s/01.problem.greeting/README.md": readme({
    title: "Greeting",
    slots: { "_sample/greeting": "greeting.ts" },
  }),
  "exercises/_s/01.solution.greeting/README.md": readme({ title: "Greeting" }),
  "playground/greeting.ts": "export const formatGreeting = (name: string) => `yo ${name}`;\n",
};

let cleanups: (() => void)[] = [];
function repo(files: Record<string, string> = {}): string {
  const made = makeRepo({ ...STEP, ...files });
  cleanups.push(made.cleanup);
  return made.root;
}
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
});

/**
 * Writes `text` to `path` and resolves once the dev server's watcher reports it. Under load the
 * watcher can start late and miss a write, so it rewrites until one is seen. The plugin's own
 * listener was added first, so it has handled the change by then.
 */
async function writeUntilWatched(server: ViteDevServer, path: string, text: string): Promise<void> {
  const seen = new Promise<void>((done) => {
    const onEvent = (file: string) => {
      if (resolve(file) !== path) return;
      server.watcher.off("add", onEvent).off("change", onEvent);
      done();
    };
    server.watcher.on("add", onEvent).on("change", onEvent);
  });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  const retry = setInterval(() => writeFileSync(path, text), 250);
  try {
    await seen;
  } finally {
    clearInterval(retry);
  }
}

describe("createSlotResolver", () => {
  it("resolves #learn imports to the reference when no step is active", () => {
    const root = repo();
    const resolver = createSlotResolver({ root, env: {} });
    expect(resolver.step).toBeNull();
    expect(resolver.resolve("#learn/_sample/greeting")).toBe(join(root, "src/core/_sample/greeting.ts"));
    expect(resolver.resolve("#/lib/utils")).toBeNull();
    expect(resolver.resolve("react")).toBeNull();
  });

  it("slots the active step's modules and leaves the others on the reference", () => {
    const root = repo();
    const resolver = createSlotResolver({ root, env: { AC_ACTIVE_STEP: "_s.1" } });
    expect(resolver.resolve("#learn/_sample/greeting")).toBe(join(root, "playground/greeting.ts"));
    expect(resolver.resolve("#learn/_sample/farewell")).toBe(join(root, "src/core/_sample/farewell.ts"));
  });

  it("reads the active step from .ex/state.json, and AC_ACTIVE_STEP wins over it", () => {
    const root = repo({ ".ex/state.json": '{"active_step": "_s.1", "passed": []}' });
    expect(createSlotResolver({ root, env: {} }).step).toBe("_s.1");
    expect(() => createSlotResolver({ root, env: { AC_ACTIVE_STEP: "_s.2" } })).toThrow(
      "no problem directory for step _s.2",
    );
  });

  it("serves the reference under AC_ACTIVE_STEP=none, whatever .ex/state.json says", () => {
    const root = repo({ ".ex/state.json": '{"active_step": "_s.1", "passed": []}' });
    const resolver = createSlotResolver({ root, env: { AC_ACTIVE_STEP: "none" } });
    expect(resolver.step).toBeNull();
    expect(resolver.resolve("#learn/_sample/greeting")).toBe(join(root, "src/core/_sample/greeting.ts"));
  });

  it("loads slots from AC_SLOT_ROOT", () => {
    const root = repo();
    const slotRoot = join(root, "exercises/_s/01.solution.greeting");
    const resolver = createSlotResolver({ root, env: { AC_ACTIVE_STEP: "_s.1", AC_SLOT_ROOT: slotRoot } });
    expect(resolver.slots.get("_sample/greeting")).toBe(join(slotRoot, "greeting.ts"));
  });

  it("names the missing file and the fix when a slot file is missing", () => {
    const root = repo();
    rmSync(join(root, "playground/greeting.ts"));
    const resolver = createSlotResolver({ root, env: { AC_ACTIVE_STEP: "_s.1" } });
    expect(() => resolver.resolve("#learn/_sample/greeting")).toThrow(
      new SlotError(
        "step _s.1 slots #learn/_sample/greeting to playground/greeting.ts, which doesn't exist; " +
          "run `pnpm ex start _s.1` or `pnpm ex reset _s.1`",
      ),
    );
  });

  it("refuses a module with no reference and a malformed slot", () => {
    const root = repo({
      "exercises/_t/01.problem.bad/README.md": readme({ title: "Bad", slots: { "../escape": "x.ts" } }),
      "exercises/_t/01.solution.bad/README.md": readme({ title: "Bad" }),
    });
    expect(() => createSlotResolver({ root, env: {} }).resolve("#learn/search/bm25")).toThrow(
      "#learn/search/bm25 has no reference module at src/core/search/bm25.ts",
    );
    expect(() => createSlotResolver({ root, env: { AC_ACTIVE_STEP: "_t.1" } })).toThrow(
      `slot "../escape" isn't a module under src/core, like search/bm25`,
    );
  });
});

describe("learnSlotsEsbuild", () => {
  it("resolves #learn imports through the active step and leaves the rest to esbuild", () => {
    const root = repo();
    type OnResolve = (args: { path: string }) => { path: string } | undefined;
    const hooks: { filter: RegExp; callback: OnResolve }[] = [];
    learnSlotsEsbuild({ root, env: { AC_ACTIVE_STEP: "_s.1" } }).setup({
      onResolve: (options, callback) => hooks.push({ filter: options.filter, callback }),
    });
    const resolveId = (path: string) => {
      const hook = hooks.find(({ filter }) => filter.test(path));
      return hook ? hook.callback({ path }) : undefined;
    };
    expect(resolveId("#learn/_sample/greeting")).toEqual({ path: join(root, "playground/greeting.ts") });
    expect(resolveId("#learn/_sample/farewell")).toEqual({ path: join(root, "src/core/_sample/farewell.ts") });
    expect(resolveId("#/lib/utils")).toBeUndefined();
    expect(resolveId("workflow")).toBeUndefined();
  });
});

// Each test starts one or two Vitest processes: about a second each here, a few on a small CI runner.
describe("in a fresh Vitest run", { timeout: 15_000 }, () => {
  const TEST = `import { expect, test } from "vitest";
import { formatFarewell } from "#learn/_sample/farewell";
import { formatGreeting } from "#learn/_sample/greeting";

test("slots", () => {
  expect(formatGreeting("x")).toBe(process.env.EXPECT_GREETING);
  expect(formatFarewell("x")).toBe("bye x");
});
`;

  async function vitest(root: string, env: Record<string, string>) {
    const args = [VITEST, "run", "--root", root];
    return run(process.execPath, args, { cwd: root, env: envWithoutVitest(env), capture: true });
  }

  it("swaps the slotted module and leaves the rest on the reference", async () => {
    const root = repo({ "src/slots.test.ts": TEST });
    const reference = await vitest(root, { EXPECT_GREETING: "hello x" });
    expect(reference.code, reference.stdout + reference.stderr).toBe(0);
    const slotted = await vitest(root, { AC_ACTIVE_STEP: "_s.1", EXPECT_GREETING: "yo x" });
    expect(slotted.code, slotted.stdout + slotted.stderr).toBe(0);
  });

  it("fails with a clear error when the slot file is missing", async () => {
    const root = repo({ "src/slots.test.ts": TEST });
    rmSync(join(root, "playground/greeting.ts"));
    const result = await vitest(root, { AC_ACTIVE_STEP: "_s.1", EXPECT_GREETING: "yo x" });
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toContain(
      "step _s.1 slots #learn/_sample/greeting to playground/greeting.ts, which doesn't exist",
    );
  });
});

describe("the dev server", () => {
  async function devServer(root: string, env: Record<string, string> = {}) {
    const logger = createLogger("silent");
    const server = await createServer({
      root,
      configFile: false,
      customLogger: { ...logger, info: vi.fn() },
      mode: "development",
      plugins: [learnSlots({ env })],
      server: { middlewareMode: true, ws: false },
    });
    return { server, restart: vi.spyOn(server, "restart").mockResolvedValue(), info: server.config.logger.info };
  }

  it("restarts when .ex/state.json names a different step", async () => {
    const root = repo();
    const { server, restart } = await devServer(root);
    try {
      const state = join(root, ".ex/state.json");
      await writeUntilWatched(server, state, '{"active_step": null, "passed": []}');
      expect(restart).not.toHaveBeenCalled();
      await writeUntilWatched(server, state, '{"active_step": "_s.1", "passed": []}');
      expect(restart).toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("restarts when you edit a slotted file, so workflow steps get the edit too", async () => {
    const root = repo();
    const { server, restart } = await devServer(root, { AC_ACTIVE_STEP: "_s.1" });
    try {
      const edit = "export const formatGreeting = (name: string) => `hey ${name}`;\n";
      await writeUntilWatched(server, join(root, "src/core/_sample/farewell.ts"), edit);
      expect(restart).not.toHaveBeenCalled();
      await writeUntilWatched(server, join(root, "playground/greeting.ts"), edit);
      expect(restart).toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("restarts again when you edit a slotted file while it restarts", async () => {
    const root = repo();
    const { server, restart, info } = await devServer(root, { AC_ACTIVE_STEP: "_s.1" });
    try {
      const greeting = join(root, "playground/greeting.ts");
      const seen: string[] = [];
      let edited = false;
      restart.mockImplementation(async () => {
        seen.push(readFileSync(greeting, "utf8"));
        if (edited) return;
        edited = true;
        // An edit that lands mid-restart, which no watcher reports.
        await server.watcher.close();
        writeFileSync(greeting, "mid-restart");
      });
      await writeUntilWatched(server, greeting, "first");
      await vi.waitFor(() => expect(seen).toContain("mid-restart"));
      expect(seen[0]).toBe("first");
      expect(info).toHaveBeenCalledWith(
        "learn-slots: playground/ changed while the server restarted; restarting again",
        expect.anything(),
      );
    } finally {
      await server.close();
    }
  });
});

describe("pausing the dev server for a switch", () => {
  const state = (root: string) => join(root, ".ex/state.json");
  const status = async (url: string) => (await fetch(`${url}/`)).status;

  async function listen(root: string, { env = {}, drainMs, plugins = [] }: ListenOptions = {}) {
    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      mode: "development",
      plugins: [learnSlots({ env, drainMs }), ...plugins],
      server: { port: 0, ws: false },
    });
    await server.listen();
    servers.push(server);
    return { server, entry: readDevServerEntry(root)! };
  }

  type ListenOptions = { env?: Record<string, string>; drainMs?: number; plugins?: Plugin[] };
  let servers: ViteDevServer[] = [];
  afterEach(async () => {
    // A restarted server is the same object, so this closes whichever server runs now.
    for (const server of servers) await server.close();
    servers = [];
  });

  /** A route that answers only once `answer()` is called. */
  function slowRoute() {
    let answer = () => {};
    const answered = new Promise<void>((done) => (answer = done));
    let arrive = () => {};
    const arrived = new Promise<void>((done) => (arrive = done));
    const events: string[] = [];
    const plugin: Plugin = {
      name: "slow-route",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== "/slow") return next();
          arrive();
          await answered;
          events.push("slow answered");
          res.end("slow");
        });
      },
    };
    return { plugin, events, arrived, answer };
  }

  it("registers itself, refuses work while paused, and restarts on the new code when resumed", async () => {
    const root = repo();
    const { server, entry } = await listen(root);
    expect(entry).toEqual({
      pid: process.pid,
      url: expect.stringMatching(/^http:\/\/localhost:\d+$/),
      token: expect.any(String),
      step: null,
      state: "running",
    });
    expect(await status(entry.url)).not.toBe(503);
    const forged = await fetch(`${entry.url}/__ex/pause`, {
      method: "POST",
      headers: { "x-ex-token": "forged", "x-ex-pid": String(process.pid) },
    });
    expect(forged.status).toBe(403);
    expect(await status(entry.url)).not.toBe(503);

    const paused = await pauseDevServer(root);
    expect(paused).toMatchObject({ open: 0 });
    const refused = await fetch(`${entry.url}/`);
    expect([refused.status, refused.headers.get("retry-after")]).toEqual([503, "1"]);
    // The switch writes the new step while paused; the restart waits for the resume.
    await writeUntilWatched(server, state(root), '{"active_step": "_s.1", "passed": []}');
    expect(readDevServerEntry(root)).toEqual(entry);

    await paused!.restart();
    // It resolves once the new server is up, on the new step.
    const next = readDevServerEntry(root)!;
    expect(next).toMatchObject({ pid: process.pid, step: "_s.1", state: "running" });
    expect(next.token).not.toBe(entry.token);
    expect(await status(next.url)).not.toBe(503);
    await server.close();
    expect(existsSync(join(root, DEV_SERVER_FILE))).toBe(false);
  });

  it("waits out a restart under way, and pauses the server that replaces it", async () => {
    const root = repo();
    let release = () => {};
    const released = new Promise<void>((done) => (release = done));
    let began = () => {};
    const restarting = new Promise<void>((done) => (began = done));
    let creations = 0;
    // A restart creates the next server before it closes this one; this holds that creation until
    // the test lets it go.
    const slowRestart: Plugin = {
      name: "slow-restart",
      async config() {
        if (creations++ === 0) return;
        began();
        await released;
      },
    };
    const { server, entry } = await listen(root, { plugins: [slowRestart] });
    await writeUntilWatched(server, state(root), '{"active_step": "_s.1", "passed": []}');
    await restarting;

    let settled = false;
    const pausing = pauseDevServer(root, { pollMs: 10 }).finally(() => (settled = true));
    await new Promise((done) => setTimeout(done, 200));
    expect(settled).toBe(false);
    release();
    const paused = await pausing;
    const next = readDevServerEntry(root)!;
    expect(next).toMatchObject({ step: "_s.1", state: "running" });
    expect(next.token).not.toBe(entry.token);
    expect(paused).toMatchObject({ open: 0 });
    expect(await status(next.url)).toBe(503);
  });

  it("keeps its entry through a restart, reading restarting until the next server writes its own", async () => {
    const root = repo();
    const seen: (DevServerEntry | null)[] = [];
    // Called once the old server is torn down and before the next one listens: the gap a reader could fall in.
    const watch: Plugin = {
      name: "watch-registry",
      async closeServer() {
        await new Promise((done) => setImmediate(done));
        seen.push(readDevServerEntry(root));
      },
    };
    const { server, entry } = await listen(root, { plugins: [watch] });
    await server.restart();
    expect(seen).toEqual([{ ...entry, state: "restarting" }]);
    const next = readDevServerEntry(root)!;
    expect(next).toMatchObject({ state: "running", step: null });
    expect(next.token).not.toBe(entry.token);
  });

  it("stays paused through a restart Vite starts on its own, and takes the resume of the pause", async () => {
    const root = repo();
    const { server, entry } = await listen(root);
    const paused = await pauseDevServer(root);
    // As when vite.config.ts is saved mid-switch.
    await server.restart();
    const next = readDevServerEntry(root)!;
    expect(next.token).not.toBe(entry.token);
    expect(await status(next.url)).toBe(503);

    await paused!.restart();
    const after = readDevServerEntry(root)!;
    expect(after).toMatchObject({ state: "running" });
    expect([entry.token, next.token]).not.toContain(after.token);
    expect(await status(after.url)).not.toBe(503);
  });

  it("answers the pause once the requests it let in have answered", async () => {
    const root = repo();
    const slow = slowRoute();
    const { entry } = await listen(root, { plugins: [slow.plugin] });
    const request = fetch(`${entry.url}/slow`).then((response) => response.text());
    await slow.arrived;

    const pausing = pauseDevServer(root).then((paused) => {
      slow.events.push("paused");
      return paused;
    });
    await new Promise((done) => setTimeout(done, 200));
    expect(slow.events).toEqual([]);
    slow.answer();
    expect(await request).toBe("slow");
    expect(await pausing).toMatchObject({ open: 0 });
    expect(slow.events).toEqual(["slow answered", "paused"]);
  });

  it("stops waiting for a request after a while, and says how many it left", async () => {
    const root = repo();
    const slow = slowRoute();
    const { entry } = await listen(root, { drainMs: 100, plugins: [slow.plugin] });
    const request = fetch(`${entry.url}/slow`).then((response) => response.text());
    await slow.arrived;
    try {
      expect(await pauseDevServer(root)).toMatchObject({ open: 1 });
    } finally {
      slow.answer();
      await request;
    }
  });

  it("fails the restart when the new server serves another step", async () => {
    const root = repo();
    await listen(root, { env: { AC_ACTIVE_STEP: "_s.1" } });
    const paused = await pauseDevServer(root);
    await expect(paused!.restart()).rejects.toMatchObject({
      message: "the dev server restarted on _s.1, not no step",
      detail: "is AC_ACTIVE_STEP set where `pnpm dev` runs?",
    });
  });

  it("fails the restart when the new server doesn't start, and the old one serves on", async () => {
    const root = repo();
    const { entry } = await listen(root);
    const paused = await pauseDevServer(root);
    // The new server's config throws: _s.9 has no problem directory.
    mkdirSync(join(root, ".ex"), { recursive: true });
    writeFileSync(state(root), '{"active_step": "_s.9", "passed": []}');
    await expect(paused!.restart()).rejects.toMatchObject({
      message: `couldn't restart the dev server at ${entry.url}`,
      detail: "the new server didn't start, so it serves the old code; its terminal shows why",
    });
    expect(readDevServerEntry(root)).toEqual({ ...entry, state: "restart-failed" });
    expect(await status(entry.url)).not.toBe(503);
  });

  it("answers the control paths it doesn't know, and a bad pause, without pausing", async () => {
    const root = repo();
    const { entry } = await listen(root);
    const headers = { "x-ex-token": entry.token };
    expect((await fetch(`${entry.url}/__ex/pause`, { headers })).status).toBe(403);
    const bad = await fetch(`${entry.url}/__ex/pause`, { method: "POST", headers: { ...headers, "x-ex-pid": "ex" } });
    expect([bad.status, await bad.text()]).toEqual([400, "x-ex-pid must be the pid of `pnpm ex`\n"]);
    expect((await fetch(`${entry.url}/__ex/stop`, { method: "POST", headers })).status).toBe(404);
    expect(await status(entry.url)).not.toBe(503);
  });

  it("restarts once the ex that paused it has exited", async () => {
    const root = repo();
    const { entry } = await listen(root);
    const gone = spawnSync(process.execPath, ["-e", ""]).pid;
    const paused = await fetch(`${entry.url}/__ex/pause`, {
      method: "POST",
      headers: { "x-ex-token": entry.token, "x-ex-pid": String(gone) },
    });
    expect(paused.status).toBe(200);
    // That request finds the pause orphaned and starts the restart; the next server takes no pause over.
    expect(await status(entry.url)).toBe(503);
    await vi.waitFor(() => expect(readDevServerEntry(root)).toMatchObject({ state: "running" }));
    const next = readDevServerEntry(root)!;
    expect(next.token).not.toBe(entry.token);
    expect(await status(next.url)).not.toBe(503);
  });

  it("refuses work until the restart after a switch is done, so nothing runs on swapped files", async () => {
    const root = repo();
    let release = () => {};
    const released = new Promise<void>((done) => (release = done));
    let creations = 0;
    const slowRestart: Plugin = {
      name: "slow-restart",
      async config() {
        if (creations++ > 0) await released;
      },
    };
    const { entry } = await listen(root, { plugins: [slowRestart] });
    const paused = await pauseDevServer(root);
    const restarting = paused!.restart();
    await vi.waitFor(() => expect(readDevServerEntry(root)?.state).toBe("restarting"));
    expect(await status(entry.url)).toBe(503);
    release();
    await restarting;
    expect(await status(readDevServerEntry(root)!.url)).not.toBe(503);
  });
});

describe("pauseDevServer", () => {
  const register = (root: string, entry: Omit<DevServerEntry, "token" | "step" | "state">) => {
    mkdirSync(join(root, ".ex"), { recursive: true });
    const full: DevServerEntry = { token: "t", step: null, state: "running", ...entry };
    writeFileSync(join(root, DEV_SERVER_FILE), JSON.stringify(full));
  };

  async function closedPort(): Promise<number> {
    const closed = createNetServer().listen(0);
    await once(closed, "listening");
    const { port } = closed.address() as AddressInfo;
    closed.close();
    return port;
  }

  /** A stand-in dev server on a free port, answering the control paths with `answers`. */
  async function fakeDevServer(answers: Record<string, [number, string]>) {
    const server = createHttpServer((req, res) => {
      const [status, body] = answers[req.url!] ?? [404, ""];
      res.writeHead(status).end(body);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(() => server.close());
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("forgets a dev server that was killed or no longer answers", async () => {
    const root = repo();
    const port = await closedPort();
    expect(await pauseDevServer(root)).toBeNull();
    register(root, { pid: spawnSync(process.execPath, ["-e", ""]).pid, url: `http://localhost:${port}` });
    expect(await pauseDevServer(root)).toBeNull();
    expect(existsSync(join(root, DEV_SERVER_FILE))).toBe(false);
    register(root, { pid: process.pid, url: `http://localhost:${port}` });
    expect(await pauseDevServer(root, { pollMs: 10, refusedMs: 50 })).toBeNull();
    expect(existsSync(join(root, DEV_SERVER_FILE))).toBe(false);
  });

  it("keeps a dev server that refuses connections for a moment, as one does while it restarts", async () => {
    const root = repo();
    register(root, { pid: process.pid, url: `http://localhost:${await closedPort()}` });
    const url = await fakeDevServer({ "/__ex/pause": [200, '{"open":0}'] });
    setTimeout(() => register(root, { pid: process.pid, url }), 100);
    expect(await pauseDevServer(root, { pollMs: 10 })).toMatchObject({ open: 0 });
  });

  it("reports a dev server that answers the pause or the resume with an error", async () => {
    const root = repo();
    const answers: Record<string, [number, string]> = { "/__ex/pause": [500, "boom\n"], "/__ex/resume": [500, ""] };
    const url = await fakeDevServer(answers);
    register(root, { pid: process.pid, url });
    await expect(pauseDevServer(root)).rejects.toMatchObject({
      message: `couldn't pause the dev server at ${url}`,
      detail: "pause answered 500 boom",
    });
    answers["/__ex/pause"] = [200, '{"open":0}'];
    const paused = await pauseDevServer(root);
    await expect(paused!.restart()).rejects.toMatchObject({
      message: `couldn't restart the dev server at ${url}`,
      detail: "resume answered 500; it restarts on its next request",
    });
  });
});
