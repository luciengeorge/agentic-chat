import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { start } from "workflow/api";
import { z } from "zod";

import type { AgentTool } from "#learn/agent/types";

import { scriptedTurns } from "#learn/model/testing";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";
import { createRunnerLoop } from "@/lib/agent-runs";
import { setAgentRuntime } from "@/lib/agent-runtime";

import { setWorkflowAgentModel, workflowAgentRun } from "./workflow-agent";

const LEO = "44444444-4444-4444-8444-444444444444";

describe.skipIf(!postgresAvailable)("the same agent on WorkflowAgent", () => {
  let t: TestDatabase;
  let tenantId: string;
  const calls: Array<{ tool: string; input: unknown; userId: string }> = [];
  const sent: string[] = [];

  const search: AgentTool = {
    name: "search_documents",
    description: "search",
    input: z.object({ query: z.string() }),
    effect: "read",
    needsApproval: () => false,
    execute: async (input, ctx) => {
      calls.push({ tool: "search_documents", input, userId: ctx.viewer.userId });
      return { passages: [{ text: "Hotels: up to 150 a night." }] };
    },
  };
  const mail: AgentTool = {
    name: "send_mail",
    description: "mail",
    input: z.object({ to: z.string() }),
    effect: "write",
    needsApproval: () => true,
    execute: async (input) => {
      sent.push((input as { to: string }).to);
      return { sent: true };
    },
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    const [{ id }] = await t.sql`
      INSERT INTO organization (name, slug, created_at) VALUES ('Kestrel Pay', 'kestrel', now()) RETURNING id`;
    tenantId = id;
    setAgentRuntime({
      db: t.appDb,
      tools: () => [search, mail],
      loop: (viewer) => createRunnerLoop(viewer, { model: scriptedTurns([]).model, tools: [], reasoningEffort: "low" }),
    });
  }, 60_000);

  afterAll(async () => {
    setAgentRuntime(null);
    setWorkflowAgentModel(null);
    await t?.drop();
  });

  it("runs the app's tools as the user, and keeps nothing in our run log", async () => {
    setWorkflowAgentModel(
      scriptedTurns([
        { toolCalls: [{ callId: "s1", name: "search_documents", input: { query: "hotel cap" } }] },
        { text: "Up to 150 a night." },
      ]).mock,
    );
    const run = await start(workflowAgentRun, [tenantId, LEO, "What's the hotel cap?"]);
    expect(await run.returnValue).toMatchObject({
      text: "Up to 150 a night.",
      steps: 2,
      tools: ["search_documents"],
      waitingOnApproval: [],
    });
    expect(calls).toEqual([{ tool: "search_documents", input: { query: "hotel cap" }, userId: LEO }]);
    expect(await t.sql`SELECT count(*)::int AS n FROM runs`).toEqual([{ n: 0 }]);
  }, 60_000);

  it("stops at a write that needs approval: the call comes back unanswered and nothing is sent", async () => {
    setWorkflowAgentModel(
      scriptedTurns([{ toolCalls: [{ callId: "m1", name: "send_mail", input: { to: "amara" } }] }]).mock,
    );
    const run = await start(workflowAgentRun, [tenantId, LEO, "Mail amara"]);
    expect(await run.returnValue).toMatchObject({ steps: 1, waitingOnApproval: ["send_mail"] });
    expect(sent).toEqual([]);
  }, 60_000);
});
