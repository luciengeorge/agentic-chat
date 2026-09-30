import { z } from "zod";

const EnvSchema = z.object({
  AC_ENV: z.enum(["dev", "test", "prod"]).default("dev"),
  AC_REDIS_URL: z.url().default("redis://localhost:6379/0"),
  AC_KEYCLOAK_URL: z.url().default("http://localhost:8081"),
  AC_GATEWAY_URL: z.url().default("http://localhost:8080"),
  AC_WEB_ORIGIN: z.url().default("http://localhost:3000"),
  AC_WEB_CLIENT_ID: z.string().min(1).default("web-bff"),
  AC_WEB_CLIENT_SECRET: z.string().min(1).default("dev-web-bff-secret"),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function getEnv(): Env {
  cached ??= EnvSchema.parse(process.env);
  if (cached.AC_ENV === "prod" && cached.AC_WEB_CLIENT_SECRET === "dev-web-bff-secret") {
    throw new Error("AC_WEB_CLIENT_SECRET must be set outside dev");
  }
  return cached;
}
