import { serve } from "@hono/node-server";
/** `pnpm fake-workspace`: serves each tenant's SharePoint on 127.0.0.1:8100. Never deploy it. */
import { resolve } from "node:path";
import { z } from "zod";

import { createLogger } from "@/lib/logger";

import { SERVICE, createApp } from "./app";

const PORT = 8100;

const logger = createLogger(SERVICE);

const env = z.enum(["dev", "test", "prod"]).parse(process.env.AC_ENV || "dev");
const corpusDir = process.env.AC_CORPUS_DIR ? resolve(process.env.AC_CORPUS_DIR) : undefined;
const { app, runtime } = createApp({ env, corpusDir });

const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: PORT }, ({ address, port }) => {
  logger.info("listening", { url: `http://${address}:${port}`, env, corpusLoaded: runtime.workspace.loaded });
});

async function stop() {
  server.close();
  await runtime.notifier.close();
  process.exit(0);
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
