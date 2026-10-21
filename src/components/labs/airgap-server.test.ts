// @vitest-environment node
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import {
  latestEgressReport,
  modelRows,
  monitorStatus,
  probe,
  probeTarget,
  startMonitor,
  stopMonitor,
} from "./airgap-server";

let server: Server | undefined;
afterEach(() => {
  stopMonitor();
  server?.close();
  server = undefined;
});

async function listen() {
  server = createServer((_, response) => response.end("ok"));
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  return (server.address() as { port: number }).port;
}

describe("modelRows", () => {
  it("puts hosted models off the machine", () => {
    const rows = modelRows(
      {},
      {
        chat: "openai.responses:gpt-6-luna",
        embeddings: "text-embedding-3-small@1536",
        reranker: "cohere/rerank-v4.0-fast",
      },
    );
    expect(rows.map((row) => [row.part, row.where, row.local])).toEqual([
      ["Chat", "api.openai.com", false],
      ["Embeddings", "api.openai.com", false],
      ["Reranker", "api.cohere.com", false],
    ]);
  });

  it("says when a model is a fake for want of a key", () => {
    const rows = modelRows({}, { chat: "fake:echo", embeddings: "fake-hashing-v1@1536", reranker: "fake-overlap-v1" });
    expect(rows.every((row) => row.local && row.where.includes("a fake"))).toBe(true);
  });

  it("puts local models in LM Studio and the reranker in this process", () => {
    const rows = modelRows(
      { MODEL_PROVIDER: "local", LOCAL_WEIGHTS_DIR: "/w" },
      {
        chat: "lmstudio.chat:qwen/qwen3-8b",
        embeddings: "text-embedding-nomic-embed-text-v1.5@768",
        reranker: "local/Xenova/bge-reranker-base@q8",
      },
    );
    expect(rows.map((row) => [row.where, row.local])).toEqual([
      ["LM Studio at 127.0.0.1:1234", true],
      ["LM Studio at 127.0.0.1:1234", true],
      ["this process, from /w", true],
    ]);
    const remote = modelRows(
      { MODEL_PROVIDER: "local", LMSTUDIO_BASE_URL: "http://10.0.0.5:1234/v1" },
      {
        chat: "lmstudio.chat:x",
        embeddings: "e@768",
        reranker: "local/r",
      },
    );
    expect(remote[0], "an LM Studio on another machine isn't local").toMatchObject({ local: false });
  });
});

describe("the egress monitor in the server", () => {
  it("lets loopback through and counts it, and refuses the rest before any lookup", async () => {
    const port = await listen();
    expect(startMonitor().on).toBe(true);
    expect((await probe("127.0.0.1", port)).outcome).toBe("connected");
    const refused = await probe("api.openai.com", 443);
    expect(refused).toMatchObject({ target: "api.openai.com:443", outcome: "refused" });
    expect(refused.ms).toBeLessThan(500);

    const status = monitorStatus();
    expect(status.allowed).toEqual([{ target: `127.0.0.1:${port}`, count: 1 }]);
    expect(status.refused.map((attempt) => `${attempt.host}:${attempt.port}`)).toEqual(["api.openai.com:443"]);
    expect(status.refusedTotal).toBe(1);
  });

  it("keeps one monitor however often it's started, and stopping takes it off", async () => {
    const first = startMonitor(new Date("2026-10-21T09:00:00Z")).since;
    expect(startMonitor(new Date("2026-10-21T10:00:00Z")).since).toBe(first);
    expect(stopMonitor()).toMatchObject({ on: false, refused: [] });
    const port = await listen();
    expect((await probe("127.0.0.1", port)).outcome).toBe("connected");
    expect(monitorStatus().on).toBe(false);
  });
});

describe("probeTarget", () => {
  it("dials the hosted APIs, LM Studio and the database where the app would", () => {
    const env = { DATABASE_URL: "postgres://ac_app:ac_app@localhost:5432/ac" };
    expect(probeTarget("openai", env)).toEqual({ host: "api.openai.com", port: 443 });
    expect(probeTarget("lmstudio", env)).toEqual({ host: "127.0.0.1", port: 1234 });
    expect(probeTarget("database", env)).toEqual({ host: "localhost", port: 5432 });
  });
});

describe("latestEgressReport", () => {
  it("reads the newest local:egress-check report", () => {
    const report = latestEgressReport();
    expect(report?.file).toMatch(/-egress\.json$/);
    expect(report?.network.find((row) => row.target === "1.1.1.1:443")).toMatchObject({ reached: false });
    expect(report?.network.find((row) => row.target === "airgap-db:5432")).toMatchObject({ reached: true });
  });

  it("is null without reports", () => {
    expect(latestEgressReport("/nonexistent-dir-for-test")).toBeNull();
  });
});
