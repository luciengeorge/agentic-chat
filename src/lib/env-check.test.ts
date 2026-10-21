import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { assertProdEnv, DEV_CRON_SECRET, missingInProd, REQUIRED_IN_PROD } from "@/lib/env-check";

const FULL = Object.fromEntries(Object.keys(REQUIRED_IN_PROD).map((name) => [name, `${name.toLowerCase()}-value`]));

describe("the prod boot check", () => {
  it("names every missing variable at once, with where it comes from", () => {
    const run = () => assertProdEnv({ AC_ENV: "prod" });
    expect(run).toThrow(/without these/);
    for (const name of Object.keys(REQUIRED_IN_PROD)) expect(run).toThrow(new RegExp(`${name}: `));
    expect(run).toThrow(/CRON_SECRET: openssl rand -hex 32; Vercel sends it/);
  });

  it("names only what's missing, and counts a blank value as missing", () => {
    const { CRON_SECRET: _cron, ...rest } = FULL;
    expect(missingInProd({ ...rest, DATABASE_ADMIN_URL: "  " })).toEqual(["DATABASE_ADMIN_URL", "CRON_SECRET"]);
  });

  it("passes with everything set", () => {
    expect(() => assertProdEnv({ AC_ENV: "prod", ...FULL })).not.toThrow();
  });

  it("refuses the dev CRON_SECRET and one under 16 characters", () => {
    expect(() => assertProdEnv({ AC_ENV: "prod", ...FULL, CRON_SECRET: DEV_CRON_SECRET })).toThrow(
      "CRON_SECRET must be set to a real secret of at least 16 characters in prod",
    );
    expect(() => assertProdEnv({ AC_ENV: "prod", ...FULL, CRON_SECRET: "a".repeat(15) })).toThrow(/CRON_SECRET/);
    expect(() => assertProdEnv({ AC_ENV: "prod", ...FULL, CRON_SECRET: "a".repeat(16) })).not.toThrow();
    expect(() => assertProdEnv({ AC_ENV: "dev", CRON_SECRET: DEV_CRON_SECRET })).not.toThrow();
  });

  it("asks for no hosted model keys when the models are local", () => {
    const { OPENAI_API_KEY: _openai, COHERE_API_KEY: _cohere, ...rest } = FULL;
    expect(missingInProd({ ...rest, MODEL_PROVIDER: "local" })).toEqual([]);
    expect(missingInProd(rest)).toEqual(["OPENAI_API_KEY", "COHERE_API_KEY"]);
  });

  it("leaves dev and test alone, whatever is missing", () => {
    expect(() => assertProdEnv({ AC_ENV: "dev" })).not.toThrow();
    expect(() => assertProdEnv({ AC_ENV: "test" })).not.toThrow();
    expect(() => assertProdEnv({}, "development")).not.toThrow();
  });

  it("runs in a production build with no AC_ENV", () => {
    expect(() => assertProdEnv({}, "production")).toThrow(/DATABASE_URL/);
  });

  it("is what .env.example documents, with the dev CRON_SECRET", () => {
    const lines = readFileSync(".env.example", "utf8").split("\n");
    for (const name of Object.keys(REQUIRED_IN_PROD)) {
      const at = lines.findIndex((line) => line.startsWith(`${name}=`));
      expect(at, name).toBeGreaterThan(0);
      expect(lines.slice(Math.max(0, at - 6), at).join("\n"), name).toContain("[prod: required");
    }
    expect(lines).toContain(`CRON_SECRET=${DEV_CRON_SECRET}`);
  });
});
