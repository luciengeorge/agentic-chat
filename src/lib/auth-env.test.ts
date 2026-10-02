import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { acEnv, assertSafeSecrets, DEV_SECRETS } from "@/lib/auth-env";

const REAL = { BETTER_AUTH_SECRET: "a".repeat(64), TOAST_SECRET: "b".repeat(64) };

describe("acEnv", () => {
  it("defaults to dev, or to prod in a production build", () => {
    expect(acEnv({})).toBe("dev");
    expect(acEnv({ NODE_ENV: "production" })).toBe("prod");
    expect(acEnv({ NODE_ENV: "production", AC_ENV: "test" })).toBe("test");
  });

  it("refuses an unknown value", () => {
    expect(() => acEnv({ AC_ENV: "staging" })).toThrow(/AC_ENV must be one of dev, test, prod/);
  });
});

describe("assertSafeSecrets", () => {
  it("refuses the dev secrets in prod", () => {
    expect(() =>
      assertSafeSecrets({ AC_ENV: "prod", ...REAL, BETTER_AUTH_SECRET: DEV_SECRETS.BETTER_AUTH_SECRET }),
    ).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => assertSafeSecrets({ AC_ENV: "prod", ...REAL, TOAST_SECRET: DEV_SECRETS.TOAST_SECRET })).toThrow(
      /TOAST_SECRET/,
    );
  });

  it("refuses a missing secret in prod", () => {
    expect(() => assertSafeSecrets({ AC_ENV: "prod", TOAST_SECRET: REAL.TOAST_SECRET })).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("accepts real secrets in prod, and the dev ones elsewhere", () => {
    expect(() => assertSafeSecrets({ AC_ENV: "prod", ...REAL })).not.toThrow();
    expect(() => assertSafeSecrets({ AC_ENV: "dev", ...DEV_SECRETS })).not.toThrow();
  });

  it("knows the values .env.example ships", () => {
    const example = Object.fromEntries(
      readFileSync(".env.example", "utf8")
        .split("\n")
        .map((line) => /^([A-Z_]+)=(\S*)/.exec(line))
        .filter((match) => match !== null)
        .map(([, key, value]) => [key, value]),
    );
    expect(example).toMatchObject(DEV_SECRETS);
  });
});
