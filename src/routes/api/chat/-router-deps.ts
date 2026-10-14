import { routeMessage } from "#learn/agent/router";
import { runRoutesDeps } from "@/routes/api/runs/-deps";

import type { RouterRouteDeps } from "./-router";

import { chatModelFromEnv } from "./-deps";

/** The router runs on the chat model at low effort: it picks one of two routes, so it needs little thought. */
export function routerDeps(): RouterRouteDeps {
  return {
    runs: runRoutesDeps(),
    route: (input) => routeMessage(input, { model: chatModelFromEnv(), reasoningEffort: "low" }),
  };
}
