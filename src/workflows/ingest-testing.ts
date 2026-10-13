/**
 * Test support for the sync and ingest workflows: a throwaway database on the app role, fake-workspace on a real
 * port (steps reach it with fetch), and a stand-in for the app's routes the steps and fake-workspace call (the
 * parse routes and the webhook). Steps read their settings from the environment when they run, in this process.
 */
import type { AddressInfo } from "node:net";

import { type ServerType, serve } from "@hono/node-server";
import { Hono } from "hono";

import { kickRelay } from "@/db/outbox";
import { createTestDatabase, type TestDatabase } from "@/db/testing";
import { DEV_SECRETS } from "@/lib/auth-env";
import { ocrPng, terminateOcr } from "@/lib/parse/ocr";
import { rasterisePage } from "@/lib/parse/rasterise.server";
import { handleOcr, handleRasterise } from "@/routes/api/ingest/-pages";
import { handleWorkspaceWebhook } from "@/routes/api/webhooks/-workspace";

import { createApp, type Runtime } from "../../servers/fake-workspace/app";
import { CONTROL_HEADER, DEV_CONTROL_TOKEN } from "../../servers/fake-workspace/control";
import { FAST } from "../../servers/fake-workspace/testing";

export interface Stack {
  t: TestDatabase;
  tenants: { kestrel: string; harbour: string };
  workspace: { url: string; runtime: Runtime };
  appUrl: string;
  /** A request to fake-workspace's control API. */
  control(method: string, path: string, json?: unknown): Promise<Response>;
  close(): Promise<void>;
}

function listen(
  fetch: (request: Request) => Response | Promise<Response>,
): Promise<{ server: ServerType; url: string }> {
  return new Promise((resolve) => {
    const server = serve({ fetch, hostname: "127.0.0.1", port: 0 }, (info: AddressInfo) =>
      resolve({ server, url: `http://127.0.0.1:${info.port}` }),
    );
  });
}

const close = (server: ServerType) => new Promise<void>((resolve) => server.close(() => resolve()));

export async function startStack(): Promise<Stack> {
  const t = await createTestDatabase();
  const [{ id: kestrel }, { id: harbour }] = await t.sql`
    INSERT INTO organization (name, slug, created_at)
    VALUES ('Kestrel Pay', 'kestrel', now()), ('Harbour Health', 'harbour', now())
    RETURNING id`;

  // The committed corpus, as `pnpm fake-workspace` serves it.
  const { app: workspaceApp, runtime } = createApp({ env: "dev", policy: FAST });
  const workspace = await listen(workspaceApp.fetch);

  const app = new Hono();
  app.post("/api/ingest/rasterise", (c) => handleRasterise(c.req.raw, rasterisePage));
  app.post("/api/ingest/ocr", (c) => handleOcr(c.req.raw, ocrPng));
  app.post("/api/webhooks/workspace", (c) => handleWorkspaceWebhook(c.req.raw, { db: t.appDb, kick: kickRelay }));
  const appServer = await listen(app.fetch);

  Object.assign(process.env, {
    AC_ENV: "test",
    DATABASE_URL: t.appUrl,
    DATABASE_ADMIN_URL: t.url,
    FAKE_WORKSPACE_URL: workspace.url,
    BETTER_AUTH_URL: appServer.url,
    BETTER_AUTH_SECRET: DEV_SECRETS.BETTER_AUTH_SECRET,
  });

  return {
    t,
    tenants: { kestrel, harbour },
    workspace: { url: workspace.url, runtime },
    appUrl: appServer.url,
    control: (method, path, json) => {
      const headers: Record<string, string> = { [CONTROL_HEADER]: DEV_CONTROL_TOKEN };
      if (json === undefined) return fetch(`${workspace.url}/_control${path}`, { method, headers });
      headers["content-type"] = "application/json";
      // A body goes only with the control API's POST and PUT routes.
      // oxlint-disable-next-line unicorn/no-invalid-fetch-options
      return fetch(`${workspace.url}/_control${path}`, { method, headers, body: JSON.stringify(json) });
    },
    async close() {
      await runtime.notifier.close();
      await close(workspace.server);
      await close(appServer.server);
      await terminateOcr();
      await t.drop();
    },
  };
}
