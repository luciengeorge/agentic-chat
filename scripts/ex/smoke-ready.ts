import { loadWorld } from "@/fixtures/world";

import { isAlive, readDevServerEntry } from "../../vite-plugins/learn-slots";
import { send, sessionCookie, signIn, type SmokeTargets } from "./smoke";

export type ReadyOptions = {
  /** How long a cold server may take; defaults to the target's `readyTimeoutMs`, else 90 s. */
  timeoutMs?: number;
  /** How long nothing may listen, with no dev server registered, before it gives up: `pnpm dev` isn't running. */
  refusedMs?: number;
  pollMs?: number;
};

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Why this answer isn't the app's own, or null when it is: JSON with the wanted status. */
async function notOurs(response: Response, status: number, what: string): Promise<string | null> {
  const type = response.headers.get("content-type") ?? "";
  if (response.status === status && type.includes("application/json")) return null;
  const body = (await response.text()).slice(0, 80).replace(/\s+/g, " ").trim();
  return `${what} answered ${response.status} ${type.split(";")[0] || "(no type)"}${body ? `: ${body}` : ""}`;
}

/** One round of probes. Null when the app answers each one as itself; otherwise what was wrong. */
async function probe(target: SmokeTargets): Promise<string | null> {
  const app = { url: target.appUrl, start: "pnpm dev" };
  const me = await notOurs(await send(target.fetch, app, "/api/me"), 401, "GET /api/me");
  if (me) return me;
  const spike = await notOurs(
    await send(target.fetch, app, "/api/spike/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "spike:smoke-ready", note: "ready" }),
    }),
    404,
    "POST /api/spike/resume",
  );
  if (spike) return spike;

  const world = loadWorld();
  const login = await signIn(target, world.user("kestrel", "leo.martin").email, world.tenant("kestrel").password);
  const failed = await notOurs(login, 200, "leo.martin's sign-in");
  if (failed) return failed;
  await send(target.fetch, app, "/api/auth/sign-out", {
    method: "POST",
    headers: { "content-type": "application/json", origin: target.appUrl, cookie: sessionCookie(login) },
    body: "{}",
  }).catch(() => {});
  return null;
}

/**
 * Waits until the dev server at `appUrl` is this app and answers as it does: its own JSON from `/api/me` and the
 * spike's resume route, and a seeded user's sign-in. A cold server may still be compiling; something else on the
 * port (another project's dev server, while ours moved to the next port) never answers like this.
 *
 * It fails at once when `.ex/dev-server.json` says our dev server runs on another URL.
 */
export async function waitForApp(
  root: string,
  target: SmokeTargets,
  { timeoutMs = target.readyTimeoutMs ?? 90_000, refusedMs = 10_000, pollMs = 500 }: ReadyOptions = {},
): Promise<string> {
  const started = Date.now();
  const want = new URL(target.appUrl);
  let last = "";
  for (;;) {
    const entry = readDevServerEntry(root);
    if (entry && isAlive(entry.pid) && new URL(entry.url).origin !== want.origin) {
      throw new Error(
        `the dev server runs on ${entry.url}, not ${target.appUrl}: something else holds port ${want.port}` +
          ` (\`lsof -nP -iTCP:${want.port} -sTCP:LISTEN\` shows what)`,
      );
    }
    try {
      const problem = entry?.state === "restarting" ? "the dev server is restarting" : await probe(target);
      if (problem === null) return `ready after ${((Date.now() - started) / 1000).toFixed(1)} s`;
      last = problem;
    } catch (error) {
      last = (error as Error).message;
      const elapsed = Date.now() - started;
      if (
        last.includes("ECONNREFUSED") &&
        !(entry && isAlive(entry.pid)) &&
        elapsed >= Math.min(refusedMs, timeoutMs)
      ) {
        throw error;
      }
    }
    if (Date.now() - started > timeoutMs) {
      const elsewhere = /text\/html/.test(last) ? `; is another app on port ${want.port}?` : "";
      throw new Error(`${target.appUrl} wasn't ready after ${timeoutMs / 1000} s: ${last}${elsewhere}`);
    }
    await sleep(pollMs);
  }
}
