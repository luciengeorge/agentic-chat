export const AC_ENVS = ["dev", "test", "prod"] as const;
export type AcEnv = (typeof AC_ENVS)[number];

type Env = Record<string, string | undefined>;

/** The Vite mode this code was built in: a production build (any mode but these two), the Vite dev server, or
 * Vitest. "none" outside Vite: tsx scripts, and the step bundles Workflow builds with esbuild in dev. Vite
 * replaces `import.meta.env` when it builds, so a production build stays one whatever the environment says when
 * it runs. The mode, unlike `import.meta.env.PROD`, doesn't follow NODE_ENV: `vite build` makes a production
 * mode build even when NODE_ENV says otherwise. */
export type Build = "production" | "development" | "test" | "none";

const BUILD: Build =
  typeof import.meta.env === "undefined"
    ? "none"
    : import.meta.env.MODE === "development"
      ? "development"
      : import.meta.env.MODE === "test"
        ? "test"
        : "production";

/** The environment every process runs in: the app, the seed, `ex` and fake-workspace. An explicit `AC_ENV` wins.
 * Otherwise the Vite dev server is dev and Vitest is test, and everything else is prod, a production build
 * included: dev behaviour has to be asked for. Each process loads `.env.local` first (through dotenv-cli in its
 * `package.json` script), which sets `AC_ENV=dev`. */
export function acEnv(env: Env = process.env, build: Build = BUILD): AcEnv {
  const value = env.AC_ENV || (build === "development" ? "dev" : build === "test" ? "test" : "prod");
  if (!(AC_ENVS as readonly string[]).includes(value)) {
    throw new Error(`AC_ENV must be one of ${AC_ENVS.join(", ")}; got "${value}"`);
  }
  return value as AcEnv;
}
