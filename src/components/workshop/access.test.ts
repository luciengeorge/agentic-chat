// @vitest-environment node
import { describe, expect, it } from "vitest";

import { databaseDown } from "./access";

describe("databaseDown", () => {
  it("is true when the ping can't reach Postgres, and false when it answers", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
    expect(await databaseDown(() => Promise.reject(refused))).toBe(true);
    expect(await databaseDown(() => Promise.resolve([{ "?column?": 1 }]))).toBe(false);
  });
});
