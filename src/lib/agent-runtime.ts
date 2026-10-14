/**
 * What every runner needs to drive a run in this app: the database and the loop bound to the viewer (lane A's
 * loop with lane D's policy, the tools, the model, the guard). Server only.
 *
 * Workflow steps can't be mocked (they run from Workflow's own bundle), so tests swap the runtime here instead:
 * the registry is process-wide, and steps run in the test's process.
 */
import type { Viewer } from "#learn/retrieve/types";
import type { Db } from "@/db/create";

import { rememberTool } from "#learn/agent/memory";
import { CHAT_REASONING_EFFORT } from "#learn/model/config";
import { appDb } from "@/db/pool";
import { withTenant } from "@/db/tenant";
import { createRunnerLoop, type RunnerLoop } from "@/lib/agent-runs";
import { agentGuard, agentTools } from "@/lib/agent-tools";
import { chatModelFromEnv } from "@/routes/api/chat/-deps";

export type AgentRunner = "workflow" | "queue" | "inline";

/** `AGENT_RUNNER`: which runner drives new runs. Workflow unless set. */
export function agentRunner(env: Record<string, string | undefined> = process.env): AgentRunner {
  const value = env.AGENT_RUNNER?.trim() || "workflow";
  if (value === "workflow" || value === "queue" || value === "inline") return value;
  throw new Error(`AGENT_RUNNER must be workflow, queue or inline, not ${JSON.stringify(value)}`);
}

export interface AgentRuntime {
  db: Db;
  loop(viewer: Viewer): RunnerLoop;
  approvalTtlMs?: number;
  /** A failed model turn's retry waits this long (Workflow's `retryAfter`; the queue's backoff base). Data, so
   * tests can make it small. */
  retryAfterMs?: number;
  /** The longest one model turn may take before it's aborted and retried. */
  stepTimeoutMs?: number;
}

export const STEP_TIMEOUT_MS = 120_000;

const OVERRIDE = Symbol.for("agentic-chat.agent-runtime");

type Store = typeof globalThis & { [OVERRIDE]?: AgentRuntime };

/** For tests: replaces the runtime until called again with null. */
export function setAgentRuntime(runtime: AgentRuntime | null): void {
  (globalThis as Store)[OVERRIDE] = runtime ?? undefined;
}

export function agentRuntime(): AgentRuntime {
  return (
    (globalThis as Store)[OVERRIDE] ?? {
      db: appDb(),
      loop: (viewer) =>
        createRunnerLoop(viewer, {
          model: chatModelFromEnv(),
          tools: [...agentTools(), rememberTool({ withTenant })],
          reasoningEffort: CHAT_REASONING_EFFORT,
          guard: agentGuard(viewer),
          maxOutputTokens: 2000,
        }),
    }
  );
}
