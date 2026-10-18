// @vitest-environment node
import { describe, expect, it } from "vitest";

import { KESTREL_TOKEN, REAL_BASE_URL, setupRealWorkspace } from "@/core/connectors/testing";

import { addFault, clearFaults, crawl, deliveries, flushDeliveries, renameItem, setClock } from "./connectors-panel";

const workspace = setupRealWorkspace();

function start() {
  const fw = workspace.start();
  return { fw, ws: { baseUrl: REAL_BASE_URL, site: "kestrel", token: KESTREL_TOKEN, fetch: fw.fetch } };
}

describe("the connectors panel", () => {
  it("crawls the drive and logs every request", async () => {
    const { ws } = start();
    const result = await crawl(ws, { pageSize: 5, maxRetries: 5 });
    expect(result).toMatchObject({ pages: 18, error: null });
    expect(result.files).toHaveLength(40);
    expect(result.requests).toHaveLength(20);
    expect(result.requests[0]).toMatchObject({ n: 1, method: "GET", status: 200 });
    expect(result.requests[0].path).toBe("/v1.0/sites/kestrel/drive/items/root/children?$top=5");
  });

  it("shows the 429s and waits a throttle causes, and a retryable error once it gives up", async () => {
    const { ws } = start();
    await addFault(ws, { kind: "throttle", after_requests: 6, count: 2, retry_after_s: 0 });
    const throttled = await crawl(ws, { pageSize: 5, maxRetries: 5 });
    expect(throttled.requests.map((r) => r.status).slice(5, 9)).toEqual([200, 429, 429, 200]);
    expect(throttled.requests[6].retryAfter).toBe("0");
    expect(throttled.waits).toEqual([0, 0]);

    await clearFaults(ws);
    await addFault(ws, { kind: "error", status: 503, retry_after_s: 0 });
    const down = await crawl(ws, { pageSize: 5, maxRetries: 1 });
    expect(down.error).toMatchObject({ status: 503, retryable: true, retryAfterMs: 0 });
    expect(down.requests).toHaveLength(2);
  });

  it("pins the clock, renames a file and lists the deliveries", async () => {
    const { fw, ws } = start();
    expect(await setClock(ws, "2026-10-18T09:00:00Z")).toEqual({ now: "2026-10-18T09:00:00Z", pinned: true });
    await renameItem(ws, fw.id("/Finance/Month-End Close Checklist.md"), "Close Checklist.md");
    const files = (await crawl(ws, { pageSize: 100, maxRetries: 0 })).files;
    expect(files.map((f) => f.path)).toContain("/Finance/Close Checklist.md");
    expect(await deliveries(ws)).toEqual([]);
    expect(await flushDeliveries(ws)).toEqual([]);
    expect((await setClock(ws, null)).pinned).toBe(false);
  });

  it("says what fake-workspace refused", async () => {
    const { ws } = start();
    await expect(addFault(ws, { kind: "latency" })).rejects.toThrow(/answered 400/);
  });
});
