import { Hono } from "hono";
import { fileURLToPath } from "node:url";

import { DEFAULT_WORLD_PATH } from "@/fixtures/world";
import { createLogger } from "@/lib/logger";

import { Clock } from "./clock";
import { DEV_CONTROL_TOKEN, controlRoutes } from "./control";
import { CorpusError, Workspace } from "./corpus";
import { DEFAULT_POLICY, type DeliveryPolicy, Notifier } from "./delivery";
import { directoryRoutes } from "./directory";
import { driveRoutes } from "./drive";
import { GraphError, errorResponse } from "./errors";
import { Faults } from "./faults";
import { subscriptionRoutes } from "./subscriptions";

export const SERVICE = "fake-workspace";
export const DEFAULT_CORPUS_DIR = fileURLToPath(new URL("../../fixtures/corpus/build", import.meta.url));

const logger = createLogger(SERVICE);

export type AppEnv = "dev" | "test" | "prod";

export interface Runtime {
  readonly env: AppEnv;
  /** What the control API's `x-workspace-control` header must carry. */
  readonly controlToken: string;
  readonly clock: Clock;
  readonly workspace: Workspace;
  readonly faults: Faults;
  readonly notifier: Notifier;
}

export interface AppOptions {
  env?: AppEnv;
  controlToken?: string;
  corpusDir?: string;
  worldPath?: string;
  policy?: DeliveryPolicy;
  clock?: Clock;
}

/** A fresh app with its own in-memory state. A corpus that fails to load leaves the APIs at 503. */
export function createApp(options: AppOptions = {}): { app: Hono; runtime: Runtime } {
  const clock = options.clock ?? new Clock();
  const runtime: Runtime = {
    env: options.env ?? "dev",
    controlToken: options.controlToken ?? DEV_CONTROL_TOKEN,
    clock,
    workspace: new Workspace(options.corpusDir ?? DEFAULT_CORPUS_DIR, options.worldPath ?? DEFAULT_WORLD_PATH),
    faults: new Faults(clock),
    notifier: new Notifier(clock, options.policy ?? DEFAULT_POLICY),
  };
  try {
    runtime.workspace.load();
  } catch (error) {
    if (!(error instanceof CorpusError)) throw error;
    logger.warn("corpus not loaded", { error: error.message });
  }

  const app = new Hono();
  /** Always 200, so a supervisor sees the service up while the corpus is still missing. */
  app.get("/health", (c) => c.json({ status: "ok", service: SERVICE, corpus_loaded: runtime.workspace.loaded }));
  driveRoutes(app, runtime);
  directoryRoutes(app, runtime);
  subscriptionRoutes(app, runtime);
  controlRoutes(app, runtime);
  app.notFound(() => errorResponse(new GraphError(404, "itemNotFound", "Not Found")));
  app.onError((error) => {
    if (error instanceof GraphError) return errorResponse(error);
    logger.error("request failed", { error });
    return errorResponse(new GraphError(500, "generalException", "An internal error occurred."));
  });
  return { app, runtime };
}
