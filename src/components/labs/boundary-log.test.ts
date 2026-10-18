// @vitest-environment node
import { describe, expect, it } from "vitest";

import { level, recentRequests, recordRequest } from "./boundary-log";

describe("the boundary lab's log", () => {
  it("works out a bucket's tokens now from the stored row, capped at its capacity", () => {
    const at = new Date("2026-10-18T09:00:30Z");
    expect(level({ bucket: "chat", tokens: 0, refilled_at: "2026-10-18T09:00:00Z" }, at)).toEqual({
      name: "chat",
      tokens: 5,
      capacity: 10,
    });
    expect(level({ bucket: "lab", tokens: 9, refilled_at: "2026-10-18T08:00:00Z" }, at).tokens).toBe(10);
  });

  it("keeps nothing outside dev", async () => {
    await recordRequest({
      request: new Request("http://localhost/api/chat", { method: "POST" }),
      pathname: "/api/chat",
      viewer: null,
      status: 401,
      ms: 3,
    });
    expect(recentRequests()).toEqual([]);
  });
});
