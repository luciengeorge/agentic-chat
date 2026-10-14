import { beforeEach, describe, expect, it, vi } from "vitest";
import { HookNotFoundError, WorkflowRunNotFoundError } from "workflow/errors";

const run = vi.hoisted(() => ({ workflowRunId: "wf-1" as string | null, status: "running" as string | Error }));
const calls = vi.hoisted(() => ({ started: 0, resumed: 0, sql: [] as string[] }));

vi.mock("workflow/api", () => ({
  getRun: () => ({
    get status() {
      return run.status instanceof Error ? Promise.reject(run.status) : Promise.resolve(run.status);
    },
  }),
  resumeHook: async (token: string) => {
    calls.resumed++;
    throw new HookNotFoundError(token);
  },
  start: async () => {
    calls.started++;
    return { runId: "wf-2" };
  },
}));
vi.mock("@/db/tenant", () => ({
  withTenantOn: async (_db: unknown, _tenant: string, fn: (tx: unknown) => unknown) =>
    fn({
      execute: async (query: { queryChunks?: unknown[] }) => {
        calls.sql.push(JSON.stringify(query.queryChunks ?? query));
        return [];
      },
    }),
}));
vi.mock("@/lib/agent-runs", () => ({
  loadRun: async () => ({ id: "r1", status: "running", workflowRunId: run.workflowRunId }),
  cancelRun: async () => "ok",
}));

const { kickAction, kickWorkflow } = await import("./agent-run-start");

const viewer = { tenantId: "t1", userId: "u1" };

describe("kicking a run's workflow", () => {
  beforeEach(() => {
    run.workflowRunId = "wf-1";
    run.status = "running";
    calls.started = 0;
    calls.resumed = 0;
    calls.sql = [];
  });

  it("starts or replaces a workflow only when there's none, or it has surely ended", () => {
    expect(kickAction(null, null)).toBe("start");
    expect(kickAction("wf", "running")).toBe("wake");
    expect(kickAction("wf", "pending")).toBe("wake");
    expect(kickAction("wf", "cancelled")).toBe("reconcile");
    expect(kickAction("wf", "failed")).toBe("replace");
    expect(kickAction("wf", "completed")).toBe("replace");
    expect(kickAction("wf", "gone")).toBe("replace");
    // The status couldn't be read: the next kick tries again.
    expect(kickAction("wf", null)).toBe("leave");
  });

  it("leaves a live workflow alone when its run hook isn't there yet, rather than start a second driver", async () => {
    // The window between bindRun and createHook: the workflow is running, but the hook isn't registered.
    await kickWorkflow({} as never, viewer, "r1");
    expect(calls.resumed).toBeGreaterThan(0);
    expect(calls.started).toBe(0);
    expect(calls.sql).toEqual([]);
  }, 10_000);

  it("leaves the run alone when the workflow's status can't be read", async () => {
    run.status = new Error("ECONNRESET");
    await kickWorkflow({} as never, viewer, "r1");
    expect(calls.started).toBe(0);
    expect(calls.sql).toEqual([]);
  });

  it("replaces a workflow that failed or no longer exists", async () => {
    for (const status of ["failed", new WorkflowRunNotFoundError("wf-1")]) {
      run.status = status;
      calls.started = 0;
      calls.sql = [];
      await kickWorkflow({} as never, viewer, "r1");
      expect(calls.started).toBe(1);
      expect(calls.sql).toHaveLength(1);
    }
  });

  it("starts a workflow for a run that has none", async () => {
    run.workflowRunId = null;
    await kickWorkflow({} as never, viewer, "r1");
    expect(calls.started).toBe(1);
  });
});
