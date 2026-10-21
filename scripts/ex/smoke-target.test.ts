// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Fetch } from "./smoke";

import { runChecks, signIn } from "./smoke";
import {
  BYPASS_HEADER,
  checkCronRefuses,
  checkCronRuns,
  checkDevOnlyClosed,
  checkServing,
  CRON_JOBS_PATHS,
  remoteChecks,
  remoteTargets,
} from "./smoke-target";

const URL_ = "https://agentic-chat-git-ship-lucien.vercel.app";
const SECRET = "cron-secret-0123456789abcdef";
const SECURITY = {
  "strict-transport-security": "max-age=63072000",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'self'",
};

type Deploy = { cronSecret?: string | null; spike?: number; headers?: Record<string, string>; protectedBy?: string };

/** A deploy as the checks see it: the home page, `/api/me`, the spike and the cron routes. */
function deploy({ cronSecret = SECRET, spike = 404, headers = SECURITY, protectedBy }: Deploy = {}) {
  const seen: { url: string; headers: Headers }[] = [];
  const fetch: Fetch = async (url, init) => {
    const request = new Request(url, init);
    seen.push({ url, headers: request.headers });
    const { pathname } = new URL(url);
    if (protectedBy && request.headers.get(BYPASS_HEADER) !== protectedBy) {
      return new Response("<html>Vercel Authentication</html>", {
        status: 401,
        headers: { "content-type": "text/html" },
      });
    }
    if (pathname === "/")
      return new Response("<html></html>", { headers: { "content-type": "text/html", ...headers } });
    if (pathname === "/api/me") return Response.json(null, { status: 401 });
    if (pathname === "/api/spike") return new Response("not found", { status: spike });
    if (pathname.startsWith("/api/cron/")) {
      if (cronSecret === null) return Response.json({ error: "CRON_SECRET is not set" }, { status: 503 });
      if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      return Response.json({ job: pathname.slice("/api/cron/".length), ms: 12, published: 0 });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch, seen };
}

describe("smoke --target", () => {
  it("checks the cron routes vercel.json schedules", () => {
    const crons = (
      JSON.parse(readFileSync(join(import.meta.dirname, "../../vercel.json"), "utf8")) as {
        crons: { path: string }[];
      }
    ).crons;
    expect([...CRON_JOBS_PATHS].sort()).toEqual(crons.map((cron) => cron.path).sort());
  });

  it("refuses a target that isn't a URL", () => {
    expect(() => remoteTargets("agentic-chat.vercel.app")).toThrow(/--target must be a URL/);
  });

  it("passes a deploy that serves, has its dev routes off, and guards its crons", async () => {
    const target = remoteTargets(`${URL_}/chat`, {}, deploy().fetch);
    expect(target.appUrl).toBe(URL_);
    expect(await checkServing(target)).toBe("GET / 200 with 4 security headers; /api/me 401 signed out");
    expect(await checkDevOnlyClosed(target)).toBe("POST /api/spike 404");
    expect(await checkCronRefuses(target)).toBe("4 routes: 401 without the secret and with a wrong one");
    expect(await checkCronRuns(target, SECRET)).toContain('relay {"published":0} in 12 ms');
  });

  it("names what's wrong with a deploy that isn't ready", async () => {
    const at = (options: Deploy) => remoteTargets(URL_, {}, deploy(options).fetch);
    await expect(checkServing(at({ headers: {} }))).rejects.toThrow(/missing strict-transport-security/);
    await expect(checkDevOnlyClosed(at({ spike: 200 }))).rejects.toThrow(
      /answered 200, want 404: is AC_ENV set to dev/,
    );
    await expect(checkCronRefuses(at({ cronSecret: null }))).rejects.toThrow(/503: CRON_SECRET isn't set/);
    await expect(checkCronRefuses(at({ cronSecret: "Bearer" }))).resolves.toContain("401");
  });

  it("says when Deployment Protection is in front, and sends the bypass secret when given", async () => {
    const guarded = deploy({ protectedBy: "bypass-0123" });
    await expect(checkServing(remoteTargets(URL_, {}, guarded.fetch))).rejects.toThrow(
      /Deployment Protection answered, not the app: set VERCEL_AUTOMATION_BYPASS_SECRET/,
    );
    const target = remoteTargets(URL_, { VERCEL_AUTOMATION_BYPASS_SECRET: "bypass-0123" }, guarded.fetch);
    expect(await checkServing(target)).toContain("200");
    expect(guarded.seen.at(-1)?.headers.get(BYPASS_HEADER)).toBe("bypass-0123");
  });

  it("skips the cron passes without SMOKE_CRON_SECRET, so a plain run changes no data", async () => {
    const { fetch, seen } = deploy();
    const checks = remoteChecks(remoteTargets(URL_, {}, fetch)).filter(([name]) => name.startsWith("cron"));
    const results = await runChecks(checks);
    expect(results.map((r) => [r.name, r.passed])).toEqual([
      ["cron routes refuse strangers", true],
      ["cron passes", true],
    ]);
    expect(results[1].detail).toBe("skipped: set SMOKE_CRON_SECRET to run them");
    expect(seen.some(({ headers }) => headers.get("authorization") === `Bearer ${SECRET}`)).toBe(false);
  });

  it("signs in with SMOKE_PASSWORD in place of world.yaml's, once the deploy's passwords changed", async () => {
    const bodies: string[] = [];
    const fetch: Fetch = async (_, init) => (bodies.push(String(init?.body)), Response.json({}));
    const target = remoteTargets(URL_, { SMOKE_PASSWORD: "the-deploys-password" }, fetch);
    await signIn(target, "leo.martin@kestrelpay.example", "dev-password");
    expect(JSON.parse(bodies[0])).toEqual({ email: "leo.martin@kestrelpay.example", password: "the-deploys-password" });
    expect(remoteTargets(URL_, {}, fetch).password).toBeUndefined();
  });
});
