// @vitest-environment node
import { describe, expect, it } from "vitest";

import { createGraphClient, retryDelay } from "#learn/connectors/graph";
import { ConnectorError } from "#learn/connectors/types";
import { KESTREL_TOKEN, REAL_BASE_URL, setupRealWorkspace } from "@/core/connectors/testing";

const workspace = setupRealWorkspace();

/** A client on the real Kestrel drive whose sleeps are recorded, not slept, and whose requests are counted. */
function start({ maxRetries = 5, pageSize = 100, token = KESTREL_TOKEN } = {}) {
  const fw = workspace.start();
  const waits: number[] = [];
  const statuses: number[] = [];
  const graph = createGraphClient({
    baseUrl: REAL_BASE_URL,
    site: "kestrel",
    token,
    pageSize,
    maxRetries,
    sleep: async (ms) => void waits.push(ms),
    fetch: async (url, init) => {
      if (statuses.length >= 200) throw new Error("200 requests: does it ever stop retrying?");
      const response = await fw.fetch(url, init);
      statuses.push(response.status);
      return response;
    },
  });
  const fault = (spec: Record<string, unknown>) => fw.control("POST", "/faults", spec);
  return { fw, graph, waits, statuses, fault };
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

describe("throttling and Retry-After", () => {
  it("waits as long as Retry-After says on a 429, then gets its answer", async () => {
    const { graph, waits, statuses, fault } = start();
    await fault({ kind: "throttle", count: 2, retry_after_s: 3 });
    const children = await graph.children("root");
    expect(children).toHaveLength(7);
    expect(statuses).toEqual([429, 429, 200]);
    expect(waits, "Retry-After: 3 means 3,000 ms, each time").toEqual([3000, 3000]);
  });

  it("backs off on its own when a 503 names no wait: 500, 1,000, 2,000 ms", async () => {
    const { graph, waits, statuses, fault } = start();
    await fault({ kind: "error", status: 503, count: 3 });
    await graph.children("root");
    expect(statuses).toEqual([503, 503, 503, 200]);
    expect(waits, "500 ms, doubling each attempt").toEqual([500, 1000, 2000]);
  });

  it("never waits more than 30 seconds, and reads a Retry-After date too", () => {
    const busy = () => new Response(null, { status: 503 });
    expect(
      [0, 1, 5, 6, 9].map((attempt) => retryDelay(busy(), attempt, 10)),
      "500 ms doubling, but never more than 30,000",
    ).toEqual([500, 1000, 16000, 30000, 30000]);
    const later = new Date(Date.now() + 5000).toUTCString();
    const wait = retryDelay(new Response(null, { status: 429, headers: { "retry-after": later } }), 0, 5);
    expect(wait, "Retry-After can be a date: wait until then").toBeGreaterThan(3000);
    expect(wait).toBeLessThanOrEqual(5000);
    expect(retryDelay(new Response(null, { status: 429, headers: { "retry-after": "0" } }), 0, 5), "0 means now").toBe(
      0,
    );
  });

  it("gives up after maxRetries, with a retryable error that carries Retry-After", async () => {
    const { graph, waits, statuses, fault } = start({ maxRetries: 2 });
    await fault({ kind: "throttle", retry_after_s: 7 });
    const error = await failure(graph.children("root"));
    expect(statuses, "the first try and 2 retries").toEqual([429, 429, 429]);
    expect(waits).toEqual([7000, 7000]);
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error, "the caller can try the whole step again later").toMatchObject({
      status: 429,
      retryable: true,
      retryAfterMs: 7000,
    });
  });

  it("fails at once on a 403 or a 404: waiting won't change the answer", async () => {
    const harbour = start({ token: "dev-workspace-harbour" });
    expect(await failure(harbour.graph.children("root"))).toMatchObject({ status: 403, retryable: false });
    expect(harbour.statuses, "a token for another site stays wrong: don't retry it").toEqual([403]);
    expect(harbour.waits).toEqual([]);

    const kestrel = start();
    expect(await failure(kestrel.graph.item("no-such-item"))).toMatchObject({ status: 404 });
    expect(kestrel.statuses, "a missing item stays missing").toEqual([404]);
  });

  it("crawls Kestrel at $top=5 through two 429s: 22 requests, two 3-second waits, all 40 files", async () => {
    const { graph, waits, statuses, fault } = start({ pageSize: 5 });
    await fault({ kind: "throttle", after_requests: 6, count: 2, retry_after_s: 3 });
    const files = [];
    for await (const page of graph.crawlPages()) files.push(...page);
    expect(files).toHaveLength(40);
    expect(statuses).toHaveLength(22);
    expect(statuses.slice(5, 9)).toEqual([200, 429, 429, 200]);
    expect(waits).toEqual([3000, 3000]);
  });
});
