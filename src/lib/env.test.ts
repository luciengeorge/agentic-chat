import { describe, expect, it } from "vitest";

import { acEnv } from "@/lib/env";

describe("acEnv", () => {
  it("takes an explicit AC_ENV, whatever built the code", () => {
    expect(acEnv({ AC_ENV: "dev" }, "production")).toBe("dev");
    expect(acEnv({ AC_ENV: "test" }, "development")).toBe("test");
    expect(acEnv({ AC_ENV: "prod" }, "none")).toBe("prod");
  });

  it("is dev only under the Vite dev server, and test under Vitest", () => {
    expect(acEnv({}, "development")).toBe("dev");
    expect(acEnv({}, "test")).toBe("test");
  });

  it("fails closed to prod in a production build and outside Vite, whatever NODE_ENV says", () => {
    expect(acEnv({}, "production")).toBe("prod");
    expect(acEnv({ NODE_ENV: "development" }, "production")).toBe("prod");
    expect(acEnv({}, "none")).toBe("prod");
    expect(acEnv({ NODE_ENV: "development" }, "none")).toBe("prod");
  });

  it("treats an empty AC_ENV as unset", () => {
    expect(acEnv({ AC_ENV: "" }, "development")).toBe("dev");
    expect(acEnv({ AC_ENV: "" }, "none")).toBe("prod");
  });

  it("knows it runs under Vitest", () => {
    expect(acEnv({})).toBe("test");
  });

  it("refuses an unknown value", () => {
    expect(() => acEnv({ AC_ENV: "staging" })).toThrow(/AC_ENV must be one of dev, test, prod/);
  });
});
