// @vitest-environment node
import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { databaseDown } from "./database-status";

describe("databaseDown", () => {
  it("is true when the ping can't reach Postgres, and false when it answers", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
    expect(await databaseDown(() => Promise.reject(refused))).toBe(true);
    expect(await databaseDown(() => Promise.resolve([{ "?column?": 1 }]))).toBe(false);
  });

  it("is true for a real client when nothing listens on the port, as when OrbStack is stopped", async () => {
    const sql = postgres("postgres://ac:ac@127.0.0.1:1/ac", { max: 1, connect_timeout: 2, onnotice: () => {} });
    try {
      expect(await databaseDown(() => sql`select 1`)).toBe(true);
    } finally {
      await sql.end({ timeout: 0 });
    }
  });
});
