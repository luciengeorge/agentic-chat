import { type Check, checkBannedUser, checkSignIn, type Fetch, readText, send, type SmokeTargets } from "./smoke";
/**
 * `pnpm ex smoke --target <url>`: the checks that make sense against a deploy (a Vercel preview, say), over HTTP
 * only. No database, no fake-workspace and no gate: those stay on this machine. It signs in as the world's people,
 * so the deploy's database needs them (section 22.2 copies them over).
 */
import { checkApproval } from "./smoke-agent";
import { checkAnswer } from "./smoke-answer";

type Env = Record<string, string | undefined>;

const REQUEST_TIMEOUT_MS = 30_000;
/** The cron routes, as `vercel.json` schedules them (a test keeps the two the same). */
export const CRON_JOBS_PATHS = ["/api/cron/relay", "/api/cron/scheduler", "/api/cron/agent-queue", "/api/cron/sync"];
/** Vercel's header for "Protection Bypass for Automation", which lets a script past Deployment Protection. */
export const BYPASS_HEADER = "x-vercel-protection-bypass";

/**
 * A deploy at `url`. `VERCEL_AUTOMATION_BYPASS_SECRET` rides on every request when it's set, and `SMOKE_PASSWORD`
 * replaces world.yaml's password for every sign-in (the deploy's, once `pnpm db:rotate-passwords` changed them).
 */
export function remoteTargets(url: string, env: Env = process.env, base: Fetch = fetch): SmokeTargets {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    throw new Error(`--target must be a URL such as https://agentic-chat-git-main-you.vercel.app, not "${url}"`);
  }
  const bypass = env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  return {
    databaseUrl: "",
    appUrl: origin,
    workspaceUrl: "",
    corpusDir: "",
    password: env.SMOKE_PASSWORD?.trim() || undefined,
    fetch: (target, init) => {
      const headers = new Headers(init?.headers);
      if (bypass) headers.set(BYPASS_HEADER, bypass);
      return base(target, { ...init, headers, signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    },
  };
}

const app = (target: SmokeTargets) => ({ url: target.appUrl, start: "the deploy" });

/** Vercel's own sign-in page, in front of a protected deploy, isn't the app's 401. */
async function protectedBy(response: Response): Promise<string | null> {
  if (response.status !== 401 || response.headers.get("content-type")?.includes("application/json")) return null;
  return "Vercel's Deployment Protection answered, not the app: set VERCEL_AUTOMATION_BYPASS_SECRET (Settings, Deployment Protection, Protection Bypass for Automation)";
}

const HEADERS = ["strict-transport-security", "x-frame-options", "x-content-type-options", "content-security-policy"];

/** The deploy serves the app: its home page with the security headers, and its own JSON 401 from `/api/me`. */
export async function checkServing(target: SmokeTargets): Promise<string> {
  const home = await send(target.fetch, app(target), "/");
  const blocked = await protectedBy(home);
  if (blocked) throw new Error(blocked);
  await readText(home, "GET /");
  const missing = HEADERS.filter((name) => !home.headers.get(name));
  if (missing.length) throw new Error(`GET / is missing ${missing.join(", ")}`);
  const me = await send(target.fetch, app(target), "/api/me");
  const type = me.headers.get("content-type") ?? "";
  if (me.status !== 401 || !type.includes("application/json")) {
    throw new Error(`GET /api/me answered ${me.status} ${type.split(";")[0] || "(no type)"}, want the app's JSON 401`);
  }
  return `GET / 200 with ${HEADERS.length} security headers; /api/me 401 signed out`;
}

/** A deploy runs as prod, so the dev-only spike routes answer 404. */
export async function checkDevOnlyClosed(target: SmokeTargets): Promise<string> {
  const response = await send(target.fetch, app(target), "/api/spike", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (response.status !== 404)
    throw new Error(`POST /api/spike answered ${response.status}, want 404: is AC_ENV set to dev?`);
  return "POST /api/spike 404";
}

/** Each cron route refuses a caller without the secret, and one with the wrong one. */
export async function checkCronRefuses(target: SmokeTargets): Promise<string> {
  for (const path of CRON_JOBS_PATHS) {
    for (const authorization of [undefined, "Bearer not-the-secret"]) {
      const response = await send(target.fetch, app(target), path, {
        headers: authorization ? { authorization } : {},
      });
      if (response.status === 503) throw new Error(`GET ${path} answered 503: CRON_SECRET isn't set on the deploy`);
      if (response.status !== 401) {
        throw new Error(
          `GET ${path} ${authorization ? "with a wrong secret" : "without the secret"} answered ${response.status}, want 401`,
        );
      }
    }
  }
  return `${CRON_JOBS_PATHS.length} routes: 401 without the secret and with a wrong one`;
}

/** Each cron route, called as Vercel calls it, does its pass and says what it did. */
export async function checkCronRuns(target: SmokeTargets, secret: string): Promise<string> {
  const done: string[] = [];
  for (const path of CRON_JOBS_PATHS) {
    const response = await send(target.fetch, app(target), path, { headers: { authorization: `Bearer ${secret}` } });
    const body = JSON.parse(await readText(response, `GET ${path}`)) as Record<string, unknown>;
    const { job, ms, ...rest } = body;
    done.push(`${String(job)} ${JSON.stringify(rest)} in ${String(ms)} ms`);
  }
  return done.join("; ");
}

export type RemoteOptions = { cronSecret?: string };

/** The checks `--target` runs. The cron passes only with `SMOKE_CRON_SECRET` set: they change the deploy's data. */
export function remoteChecks(target: SmokeTargets, { cronSecret }: RemoteOptions = {}): [string, Check][] {
  return [
    ["serving", () => checkServing(target)],
    ["dev-only routes off", () => checkDevOnlyClosed(target)],
    ["cron routes refuse strangers", () => checkCronRefuses(target)],
    [
      "cron passes",
      async () => (cronSecret ? checkCronRuns(target, cronSecret) : "skipped: set SMOKE_CRON_SECRET to run them"),
    ],
    ["sign in and /api/me", () => checkSignIn(target)],
    ["banned user refused", () => checkBannedUser(target)],
    ["answer", () => checkAnswer(target)],
    ["hooks and streams", () => checkApproval(target, { mailbox: false })],
  ];
}
