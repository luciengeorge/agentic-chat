import { acEnv, type Build } from "@/lib/env";

// The values .env.example ships with. They're public, so prod refuses them.
export const DEV_SECRETS = {
  BETTER_AUTH_SECRET: "dev-better-auth-secret-not-for-production",
  TOAST_SECRET: "dev-toast-secret-not-for-production-use",
} as const;

// `openssl rand -hex 32` gives 64 characters; better-auth itself asks for at least 32.
const MIN_SECRET_LENGTH = 32;

type Env = Record<string, string | undefined>;

export function assertSafeSecrets(env: Env = process.env, build?: Build) {
  if (acEnv(env, build) !== "prod") return;
  for (const [name, devValue] of Object.entries(DEV_SECRETS)) {
    const value = env[name];
    if (!value || value === devValue || value.length < MIN_SECRET_LENGTH) {
      throw new Error(`${name} must be set to a real secret of at least ${MIN_SECRET_LENGTH} characters in prod`);
    }
  }
}
