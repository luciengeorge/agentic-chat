// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { Run } from "./process";

import { parseLsof, parsePs, preflight } from "./services";
import { makeRepo } from "./test-repo";

describe("parsePs", () => {
  it("reads one object per line and the older single array", () => {
    const row = { Service: "paradedb", State: "running", Health: "healthy" };
    const expected = [{ name: "paradedb", state: "running", health: "healthy" }];
    expect(parsePs(`${JSON.stringify(row)}\n`)).toEqual(expected);
    expect(parsePs(JSON.stringify([row]))).toEqual(expected);
    expect(parsePs(JSON.stringify({ ...row, Health: "" }))).toEqual([{ ...expected[0], health: null }]);
    expect(parsePs("")).toEqual([]);
  });
});

describe("parseLsof", () => {
  it("pairs each listening port with its process", () => {
    const output = ["p501", "cpostgres", "n127.0.0.1:5432", "n[::1]:5432", "p77", "ccom.docker.backend", "n*:8100", ""];
    expect(parseLsof(output.join("\n"), new Set([5432, 8100]))).toEqual([
      { port: 5432, process: "postgres", pid: 501 },
      { port: 8100, process: "com.docker.backend", pid: 77 },
    ]);
  });
});

describe("preflight", () => {
  const config = JSON.stringify({ services: { paradedb: { ports: [{ published: "5432", target: 5432 }] } } });
  const run: Run = async () => ({ code: 0, stdout: config, stderr: "" });

  it("refuses when a process outside Docker holds a published port", async () => {
    const { root, cleanup } = makeRepo({ "compose.yaml": "services: {}\n" });
    try {
      const listeners = async () => [{ port: 5432, process: "postgres", pid: 501 }];
      await expect(preflight(root, { run, listeners })).rejects.toMatchObject({
        message: "ports already in use: 5432 (postgres)",
        detail: [{ port: 5432, service: "paradedb", process: "postgres", pid: 501 }],
      });
      const docker = async () => [{ port: 5432, process: "OrbStack Helper", pid: 9 }];
      await expect(preflight(root, { run, listeners: docker })).resolves.toBeUndefined();
    } finally {
      cleanup();
    }
  });
});
