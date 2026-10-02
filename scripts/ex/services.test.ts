// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { Run } from "./process";

import { parseLsof, parsePs, preflight, up } from "./services";
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

describe("up", () => {
  const config = JSON.stringify({ services: { paradedb: { ports: [{ published: "5432", target: 5432 }] } } });
  const ps = JSON.stringify({ Service: "paradedb", State: "running", Health: "healthy" });

  /** Records each command; `pnpm <failing>` exits 1. */
  function fakeRun(failing?: string) {
    const calls: string[] = [];
    const run: Run = async (command, args) => {
      const line = [command, ...args.filter((arg) => !arg.includes("/"))].join(" ");
      calls.push(line);
      if (line.endsWith("config --format json")) return { code: 0, stdout: config, stderr: "" };
      if (line.endsWith("ps --all --format json")) return { code: 0, stdout: ps, stderr: "" };
      if (failing && line === `pnpm --silent ${failing}`) return { code: 1, stdout: "", stderr: "boom" };
      return {
        code: 0,
        stdout: line.endsWith("db:seed") ? "kestrel: already seeded\nharbour: already seeded\n" : "",
        stderr: "",
      };
    };
    return { calls, run };
  }
  const listeners = async () => [];

  it("starts Compose, then migrates and seeds through the package scripts", async () => {
    const { root, cleanup } = makeRepo({ "compose.yaml": "services: {}\n", ".env.local": "AC_ENV=dev\n" });
    try {
      const { calls, run } = fakeRun();
      expect(await up(root, { capture: true, run, listeners })).toEqual({
        services: [{ name: "paradedb", state: "running", health: "healthy" }],
        seed: ["kestrel: already seeded", "harbour: already seeded"],
      });
      expect(calls).toEqual([
        "docker compose -f config --format json",
        "docker compose -f up --detach --wait",
        "pnpm --silent db:migrate",
        "pnpm --silent db:seed",
        "docker compose -f ps --all --format json",
      ]);
    } finally {
      cleanup();
    }
  });

  it("stops at the first step that fails", async () => {
    const { root, cleanup } = makeRepo({ "compose.yaml": "services: {}\n", ".env.local": "AC_ENV=dev\n" });
    try {
      const { calls, run } = fakeRun("db:migrate");
      await expect(up(root, { capture: true, run, listeners })).rejects.toMatchObject({
        message: "pnpm db:migrate failed",
        detail: "boom",
      });
      expect(calls.at(-1)).toBe("pnpm --silent db:migrate");
    } finally {
      cleanup();
    }
  });

  it("refuses before starting anything without .env.local", async () => {
    const { root, cleanup } = makeRepo({ "compose.yaml": "services: {}\n" });
    try {
      const { calls, run } = fakeRun();
      await expect(up(root, { capture: true, run, listeners })).rejects.toMatchObject({
        message: ".env.local is missing",
        detail: "copy the dev values: cp .env.example .env.local",
      });
      expect(calls).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
