// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Route as runRoute } from "./$runId/index";
import { Route as streamRoute } from "./$runId/stream";
import { Route as startRoute } from "./index";
import { Route as resumeRoute } from "./resume";

type Handler = (ctx: { request: Request; params: Record<string, string> }) => Promise<Response>;

const handler = (route: { options: unknown }, method: "GET" | "POST") =>
  (route.options as { server: { handlers: Record<string, Handler> } }).server.handlers[method];

const APP = "http://localhost:3000";

function post(path: string, headers: Record<string, string>, body = "{}") {
  return new Request(`${APP}${path}`, { method: "POST", headers, body });
}

describe("the spike routes", () => {
  const saved = { AC_ENV: process.env.AC_ENV, BETTER_AUTH_URL: process.env.BETTER_AUTH_URL };

  beforeEach(() => {
    Object.assign(process.env, { AC_ENV: "dev", BETTER_AUTH_URL: APP });
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("refuse a write from another origin", async () => {
    const headers = { origin: "https://evil.example", "content-type": "application/json" };
    for (const [route, path] of [
      [startRoute, "/api/spike"],
      [resumeRoute, "/api/spike/resume"],
    ] as const) {
      const response = await handler(route, "POST")({ request: post(path, headers), params: {} });
      expect(response.status, path).toBe(403);
    }
  });

  it("refuse a body that isn't JSON, as a cross-origin form would send", async () => {
    const headers = { origin: APP, "content-type": "application/x-www-form-urlencoded" };
    for (const [route, path] of [
      [startRoute, "/api/spike"],
      [resumeRoute, "/api/spike/resume"],
    ] as const) {
      const response = await handler(route, "POST")({ request: post(path, headers, "token=x"), params: {} });
      expect(response.status, path).toBe(415);
    }
  });

  it("let a same-origin JSON request through", async () => {
    const request = post("/api/spike/resume", { origin: APP, "content-type": "application/json; charset=utf-8" });
    // An empty body has no token: the route's own validation answers, after the guard let it in.
    expect((await handler(resumeRoute, "POST")({ request, params: {} })).status).toBe(400);
  });

  it("answer 404 outside dev", async () => {
    process.env.AC_ENV = "test";
    const json = { "content-type": "application/json" };
    const params = { runId: "wrun_x" };
    const responses = await Promise.all([
      handler(startRoute, "POST")({ request: post("/api/spike", json), params: {} }),
      handler(resumeRoute, "POST")({ request: post("/api/spike/resume", json), params: {} }),
      handler(runRoute, "GET")({ request: new Request(`${APP}/api/spike/wrun_x`), params }),
      handler(streamRoute, "GET")({ request: new Request(`${APP}/api/spike/wrun_x/stream`), params }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404]);
  });
});
