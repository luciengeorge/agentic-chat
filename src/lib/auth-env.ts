export const AC_ENVS = ["dev", "test", "prod"] as const;
export type AcEnv = (typeof AC_ENVS)[number];

// The values .env.example ships with. They're public, so prod refuses them.
export const DEV_SECRETS = {
  BETTER_AUTH_SECRET: "dev-better-auth-secret-not-for-production",
  TOAST_SECRET: "dev-toast-secret-not-for-production-use",
} as const;

type Env = Record<string, string | undefined>;

// Unset means dev, except in a production build, where it means prod: forgetting AC_ENV on a deploy
// must not switch on dev behaviour.
export function acEnv(env: Env = process.env): AcEnv {
  const value = env.AC_ENV ?? (env.NODE_ENV === "production" ? "prod" : "dev");
  if (!(AC_ENVS as readonly string[]).includes(value)) {
    throw new Error(`AC_ENV must be one of ${AC_ENVS.join(", ")}; got "${value}"`);
  }
  return value as AcEnv;
}

export function assertSafeSecrets(env: Env = process.env) {
  if (acEnv(env) !== "prod") return;
  for (const [name, devValue] of Object.entries(DEV_SECRETS)) {
    const value = env[name];
    if (!value || value === devValue) {
      throw new Error(`${name} must be set to a real secret when AC_ENV=prod`);
    }
  }
}
