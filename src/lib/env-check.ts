import { acEnv, type Build } from "@/lib/env";

type Env = Record<string, string | undefined>;

/** What a prod server needs before its first request, and where each value comes from (`.env.example` says more). */
export const REQUIRED_IN_PROD = {
  DATABASE_URL: "the app role on the cloud database: postgres://ac_app:<password>@<host>:5432/ac",
  DATABASE_ADMIN_URL: "the database's owner, for migrations and the cron routes' cross-tenant work",
  BETTER_AUTH_SECRET: "openssl rand -hex 32",
  BETTER_AUTH_URL: "this deployment's own origin, e.g. https://agentic-chat.vercel.app",
  TOAST_SECRET: "openssl rand -hex 32",
  CRON_SECRET: "openssl rand -hex 32; Vercel sends it to the cron routes",
  OPENAI_API_KEY: "platform.openai.com, API keys",
  COHERE_API_KEY: "dashboard.cohere.com, API keys",
} as const;

export type RequiredName = keyof typeof REQUIRED_IN_PROD;

/** The hosted models' keys aren't needed when every model runs on the machine (section 21). */
const MODEL_KEYS: readonly RequiredName[] = ["OPENAI_API_KEY", "COHERE_API_KEY"];

/** The required names that are unset or blank in `env`. */
export function missingInProd(env: Env = process.env): RequiredName[] {
  const local = env.MODEL_PROVIDER?.trim() === "local";
  return (Object.keys(REQUIRED_IN_PROD) as RequiredName[]).filter(
    (name) => !(local && MODEL_KEYS.includes(name)) && !env[name]?.trim(),
  );
}

/** `.env.example`'s value, so a local cron route can be called by hand. Public, so prod refuses it. */
export const DEV_CRON_SECRET = "dev-cron-secret-not-for-production";
/** Vercel asks for at least 16 characters. */
const MIN_CRON_SECRET = 16;

/**
 * In prod, refuses to boot while a required variable is missing, naming every one and where it comes from, or while
 * CRON_SECRET is the dev value or too short. BETTER_AUTH_SECRET and TOAST_SECRET get the same check from
 * `assertSafeSecrets`.
 */
export function assertProdEnv(env: Env = process.env, build?: Build): void {
  if (acEnv(env, build) !== "prod") return;
  const missing = missingInProd(env);
  if (missing.length) {
    const lines = missing.map((name) => `  ${name}: ${REQUIRED_IN_PROD[name]}`);
    throw new Error(`The server can't start in prod without these (see .env.example):\n${lines.join("\n")}`);
  }
  const cron = env.CRON_SECRET!.trim();
  if (cron === DEV_CRON_SECRET || cron.length < MIN_CRON_SECRET) {
    throw new Error(`CRON_SECRET must be set to a real secret of at least ${MIN_CRON_SECRET} characters in prod`);
  }
}
