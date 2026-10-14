// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Fetch, SmokeTargets } from "./smoke";

import { DEFAULT_CORPUS_DIR } from "../../servers/fake-workspace/app";
import { DEV_SERVER_FILE } from "../../vite-plugins/learn-slots";
import { runChecks, smokeChecks } from "./smoke";
import { waitForApp } from "./smoke-ready";
import { refused } from "./test-repo";

const APP = "http://localhost:3000";

const targets = (fetch: Fetch): SmokeTargets => ({
  databaseUrl: "",
  appUrl: APP,
  workspaceUrl: "http://localhost:8100",
  corpusDir: DEFAULT_CORPUS_DIR,
  fetch,
});

const html = () =>
  new Response("<!DOCTYPE html><html>Not Found</html>", { status: 404, headers: { "content-type": "text/html" } });

/** This app once `warm` requests have gone by: before that, what a cold or foreign server answers. */
function app({ coldFor = 0, cold = html }: { coldFor?: number; cold?: () => Response } = {}): Fetch & {
  calls: number;
} {
  const fetch = async (url: string) => {
    fetch.calls += 1;
    if (fetch.calls <= coldFor) return cold();
    const { pathname } = new URL(url);
    if (pathname === "/api/me") return Response.json({ error: "unauthorized" }, { status: 401 });
    if (pathname === "/api/spike/resume") return Response.json({ error: "hook not found" }, { status: 404 });
    if (pathname === "/api/auth/sign-in/email") {
      return Response.json({}, { headers: { "set-cookie": "session=abc; Path=/" } });
    }
    if (pathname === "/api/auth/sign-out") return Response.json({});
    return html();
  };
  fetch.calls = 0;
  return fetch;
}

describe("waitForApp", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "smoke-ready-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("is ready when the app answers as itself", async () => {
    expect(await waitForApp(root, targets(app()), { pollMs: 1 })).toMatch(/^ready after \d+\.\d s$/);
  });

  it("waits while the server refuses connections or answers like a cold one", async () => {
    let refusals = 3;
    const warm = app({
      coldFor: 4,
      cold: () => Response.json({ message: "Invalid email or password" }, { status: 401 }),
    });
    const fetch: Fetch = (url, init) => (refusals-- > 0 ? refused(url, init) : warm(url, init));
    expect(await waitForApp(root, targets(fetch), { pollMs: 1 })).toMatch(/^ready/);
    expect(warm.calls).toBeGreaterThan(4);
  });

  it("gives up soon when nothing listens and no dev server is registered", async () => {
    await expect(waitForApp(root, targets(refused), { refusedMs: 20, pollMs: 1 })).rejects.toThrow(
      "GET http://localhost:3000/api/me failed (ECONNREFUSED); is `pnpm dev` running?",
    );
  });

  it("gives up on another app on the port, and says so", async () => {
    await expect(waitForApp(root, targets(app({ coldFor: Infinity })), { timeoutMs: 30, pollMs: 1 })).rejects.toThrow(
      "http://localhost:3000 wasn't ready after 0.03 s: GET /api/me answered 404 text/html: <!DOCTYPE html><html>Not Found</html>; is another app on port 3000?",
    );
  });

  it("fails at once when our dev server runs on another port", async () => {
    mkdirSync(join(root, ".ex"));
    const entry = { pid: process.pid, url: "http://localhost:3001", token: "t", step: null, state: "running" };
    writeFileSync(join(root, DEV_SERVER_FILE), JSON.stringify(entry));
    await expect(waitForApp(root, targets(app()), { pollMs: 1 })).rejects.toThrow(
      "the dev server runs on http://localhost:3001, not http://localhost:3000: something else holds port 3000",
    );
  });
});

describe("smokeChecks", () => {
  it("has the twelve checks, and fails the app's ones with the reason when it isn't ready", async () => {
    const checks = smokeChecks("/nowhere", targets(refused), () => Promise.reject(new Error("not warm")));
    expect(checks.map(([name]) => name)).toEqual([
      "paradedb extensions and queries",
      "sign in and /api/me",
      "banned user refused",
      "fake-workspace sharing and directory",
      "spike workflow",
      "ex gate",
      "ingestion",
      "retrieval",
      "answer",
      "agent",
      "approval",
      "red-team",
    ]);
    const app = ["sign in and /api/me", "banned user refused", "spike workflow", "answer", "agent", "approval"];
    const results = await runChecks(checks.filter(([name]) => app.includes(name)));
    expect(results.map((r) => r.detail)).toEqual(app.map(() => "the app isn't ready: not warm"));
  });
});
