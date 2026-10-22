// @vitest-environment node

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEV_SECRETS } from "@/lib/auth-env";
import { REQUIRED_IN_PROD } from "@/lib/env-check";

const ROOT = join(import.meta.dirname, "../..");
const SERVER = join(ROOT, ".output/server/index.mjs");

// What a deploy that forgot everything looks like: no AC_ENV, no NODE_ENV, nothing from .env.local.
let base: Record<string, string>;
let dataDir: string;

async function freePort() {
  const server = createServer().listen(0, "127.0.0.1");
  await new Promise((done) => server.once("listening", done));
  const { port } = server.address() as { port: number };
  await new Promise((done) => server.close(done));
  return port;
}

/** Everything the boot check asks for, with placeholder values; each test overrides what it's about. */
const PLACEHOLDERS = Object.fromEntries(
  Object.keys(REQUIRED_IN_PROD).map((name) => [name, "placeholder-value-long-enough-for-any-check"]),
);

// A server that wrongly starts is killed after the timeout, on a port of its own.
async function bootAndExit(env: Record<string, string>) {
  const result = spawnSync(process.execPath, [SERVER], {
    cwd: ROOT,
    env: { ...base, PORT: String(await freePort()), ...env },
    timeout: 15_000,
    killSignal: "SIGKILL",
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("the production build", () => {
  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), "ac-prod-world-"));
    // The local world keeps its runs here, away from the dev server's .workflow-data.
    base = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", WORKFLOW_LOCAL_DATA_DIR: dataDir };

    // Built as `pnpm build` builds it, without the AC_*, NODE_ENV and VITEST variables this run has.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(AC_|VITEST)/.test(key) && key !== "NODE_ENV"),
    );
    const build = spawnSync("pnpm", ["build"], { cwd: ROOT, env, encoding: "utf8" });
    expect(build.status, `${build.stdout}${build.stderr}`).toBe(0);
  }, 180_000);

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("refuses to start with no environment at all, naming what's missing", async () => {
    const { status, output } = await bootAndExit({});
    expect(status).not.toBe(0);
    expect(output).toContain("The server can't start in prod without these");
    expect(output).toContain("  CRON_SECRET: ");
    expect(output).toContain("  BETTER_AUTH_SECRET: ");
  }, 30_000);

  it("refuses the dev secrets without AC_ENV", async () => {
    const { status, output } = await bootAndExit({ ...PLACEHOLDERS, ...DEV_SECRETS });
    expect(status).not.toBe(0);
    expect(output).toContain("BETTER_AUTH_SECRET must be set to a real secret");
  }, 30_000);

  it("runs as prod with real secrets and no AC_ENV, so the dev-only routes answer 404 and cron wants its secret", async () => {
    const port = await freePort();
    const server = spawn(process.execPath, [SERVER], {
      cwd: ROOT,
      env: {
        ...base,
        ...PLACEHOLDERS,
        PORT: String(port),
        BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
        TOAST_SECRET: randomBytes(32).toString("hex"),
        DATABASE_URL: "postgres://ac:ac@127.0.0.1:5432/ac",
        DATABASE_ADMIN_URL: "postgres://ac:ac@127.0.0.1:5432/ac",
        BETTER_AUTH_URL: `http://localhost:${port}`,
      },
    });
    let output = "";
    server.stdout.on("data", (chunk) => (output += chunk));
    server.stderr.on("data", (chunk) => (output += chunk));
    try {
      await expect.poll(() => output, { timeout: 20_000, interval: 100 }).toContain("Listening on");
      const response = await fetch(`http://localhost:${port}/api/spike`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(10_000),
      });
      expect(response.status, output).toBe(404);
      // The cron routes are in the build, and refuse a caller without the secret.
      const cron = await fetch(`http://localhost:${port}/api/cron/relay`, { signal: AbortSignal.timeout(10_000) });
      expect(cron.status, output).toBe(401);
      // The local world starts from the build, so `pnpm start` recovers runs after a restart.
      expect(output).not.toContain("world start failed");
    } finally {
      server.kill("SIGKILL");
    }
  }, 30_000);
});
