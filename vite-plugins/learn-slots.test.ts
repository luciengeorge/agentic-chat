// @vitest-environment node
import type { AddressInfo } from "node:net";
import type { ViteDevServer } from "vite";

import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createServer } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { pauseDevServer } from "../scripts/ex/dev-server";
import { run } from "../scripts/ex/process";
import { envWithoutVitest, makeRepo, readme } from "../scripts/ex/test-repo";
import {
  createSlotResolver,
  DEV_SERVER_FILE,
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
    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      mode: "development",
      plugins: [learnSlots({ env })],
      server: { middlewareMode: true, ws: false },
    });
    return { server, restart: vi.spyOn(server, "restart").mockResolvedValue() };
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
    const { server, restart } = await devServer(root, { AC_ACTIVE_STEP: "_s.1" });
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
    } finally {
      await server.close();
    }
  });
});

describe("pausing the dev server for a switch", () => {
  async function listen(root: string) {
    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      mode: "development",
      plugins: [learnSlots({ env: {} })],
      server: { port: 0, ws: false },
    });
    await server.listen();
    const restart = vi.spyOn(server, "restart").mockResolvedValue();
    const entry = readDevServerEntry(root)!;
    const status = async () => (await fetch(`${entry.url}/`)).status;
    return { server, restart, entry, status };
  }

  it("registers itself, refuses work while paused, and restarts on the new code when resumed", async () => {
    const root = repo();
    const { server, restart, entry, status } = await listen(root);
    try {
      expect(entry).toEqual({
        pid: process.pid,
        url: expect.stringMatching(/^http:\/\/localhost:\d+$/),
        token: expect.any(String),
      });
      expect(await status()).not.toBe(503);
      const forged = await fetch(`${entry.url}/__ex/pause`, {
        method: "POST",
        headers: { "x-ex-token": "forged", "x-ex-pid": String(process.pid) },
      });
      expect(forged.status).toBe(403);
      expect(await status()).not.toBe(503);

      const resume = await pauseDevServer(root);
      expect(await status()).toBe(503);
      // The switch writes the new step while paused; the restart waits for the resume.
      await writeUntilWatched(server, join(root, ".ex/state.json"), '{"active_step": "_s.1", "passed": []}');
      expect(restart).not.toHaveBeenCalled();

      await resume!();
      await vi.waitFor(() => expect(restart).toHaveBeenCalled());
      expect(await status()).not.toBe(503);
    } finally {
      await server.close();
    }
    expect(existsSync(join(root, DEV_SERVER_FILE))).toBe(false);
  });

  it("lifts the pause once the ex that paused it has exited", async () => {
    const root = repo();
    const { server, restart, entry, status } = await listen(root);
    try {
      const gone = spawnSync(process.execPath, ["-e", ""]).pid;
      const paused = await fetch(`${entry.url}/__ex/pause`, {
        method: "POST",
        headers: { "x-ex-token": entry.token, "x-ex-pid": String(gone) },
      });
      expect(paused.status).toBe(200);
      expect(await status()).not.toBe(503);
      expect(restart).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });

  it("forgets a dev server that was killed or no longer answers", async () => {
    const root = repo();
    const closed = createNetServer().listen(0);
    await once(closed, "listening");
    const { port } = closed.address() as AddressInfo;
    closed.close();
    const register = (pid: number) => {
      mkdirSync(join(root, ".ex"), { recursive: true });
      writeFileSync(join(root, DEV_SERVER_FILE), JSON.stringify({ pid, url: `http://localhost:${port}`, token: "t" }));
    };
    expect(await pauseDevServer(root)).toBeNull();
    register(spawnSync(process.execPath, ["-e", ""]).pid);
    expect(await pauseDevServer(root)).toBeNull();
    expect(existsSync(join(root, DEV_SERVER_FILE))).toBe(false);
    register(process.pid);
    expect(await pauseDevServer(root)).toBeNull();
    expect(existsSync(join(root, DEV_SERVER_FILE))).toBe(false);
  });
});
