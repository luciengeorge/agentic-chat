import { waitUntil as vercelWaitUntil } from "@vercel/functions";

import { acEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";

const logger = createLogger("relay");

/**
 * Who hears `kickRelay()`. In dev, the relay plugin's loop. On Vercel no loop stays up, so the function that wrote
 * the row runs one relay pass itself, after its response, instead of leaving the row for the next minute's cron.
 * Anywhere else (`pnpm start`), nobody: the cron routes drain it.
 */
export type RelayMode = "loop" | "after-response" | "off";

type Env = Record<string, string | undefined>;

export function relayMode(env: Env = process.env): RelayMode {
  if (acEnv(env) === "dev") return "loop";
  return env.VERCEL ? "after-response" : "off";
}

/**
 * Each kick runs `pass` once, handed to Vercel's `waitUntil` so the function stays up until it ends, after the
 * response has gone. Outside a Vercel request `waitUntil` does nothing and the pass just runs. A failed pass is
 * logged, never thrown: the cron picks the row up anyway.
 */
export function passAfterResponse(
  pass: () => Promise<unknown>,
  waitUntil: (promise: Promise<unknown>) => void = vercelWaitUntil,
): () => void {
  return () => {
    waitUntil(
      pass().then(
        (result) => logger.info("relay kick pass", { ...(result as object) }),
        (error: unknown) => logger.error("relay kick pass failed", { error }),
      ),
    );
  };
}
