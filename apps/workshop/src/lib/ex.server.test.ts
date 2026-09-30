import { execFile } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { stepsResponse } from "./ex.server";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

type Callback = (error: Error | null, result?: { stdout: string; stderr: string }) => void;

/** Makes the mocked execFile finish the way `promisify` expects: `(error, { stdout, stderr })`. */
function exResult(error: (Error & { stdout?: string; stderr?: string }) | null, stdout = "") {
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    (args.at(-1) as Callback)(error, { stdout, stderr: "" });
  }) as unknown as typeof execFile);
}

const list = {
  sections: [{ id: "00", slug: "tour", title: "Tour", hidden: false, steps: [] }],
};

describe("GET /api/steps", () => {
  beforeEach(() => {
    vi.mocked(execFile).mockReset();
  });

  it("runs `uv run ex list --json` from the repo root without a shell", async () => {
    exResult(null, JSON.stringify(list));

    await stepsResponse();

    const [file, args, options] = vi.mocked(execFile).mock.calls[0]!;
    expect(file).toBe("uv");
    expect(args).toEqual(["run", "ex", "list", "--json"]);
    expect(options).toMatchObject({ cwd: expect.stringMatching(/agentic-chat$/) });
    expect(options).not.toHaveProperty("shell");
  });

  it("returns the validated step list", async () => {
    exResult(null, JSON.stringify(list));

    const response = await stepsResponse();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(list);
  });

  it("passes on the error JSON when ex fails", async () => {
    const error = Object.assign(new Error("exit 1"), {
      stdout: JSON.stringify({ error: "no_exercises", detail: "exercises/ not found" }),
    });
    exResult(error);

    const response = await stepsResponse();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "no_exercises", detail: "exercises/ not found" });
  });

  it("reports stderr when ex fails without JSON", async () => {
    exResult(Object.assign(new Error("spawn uv ENOENT"), { stdout: "", stderr: "" }));

    const response = await stepsResponse();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "ex_failed", detail: "spawn uv ENOENT" });
  });

  it("rejects output that doesn't match the contract", async () => {
    exResult(null, JSON.stringify({ sections: [{ id: "00" }] }));

    const response = await stepsResponse();

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "invalid_ex_output" });
  });
});
