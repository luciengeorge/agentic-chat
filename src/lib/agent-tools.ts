import type { RunGuard } from "#learn/agent/loop";
/** The agent's tools and guard, wired to the app: the tenant's database, retrieval and Graph. Server only. */
import type { AgentTool } from "#learn/agent/types";
import type { Viewer } from "#learn/retrieve/types";

import { createRunGuard } from "#learn/agent/budget";
import { createAgentTools } from "#learn/agent/tools/index";
import { createWorkspaceWriter } from "#learn/agent/tools/workspace";
import { withTenant } from "@/db/tenant";
import { retrieve } from "@/lib/retrieval.server";
import { tenantSlug, workspaceToken, workspaceUrl } from "@/workflows/sync-common";

let tools: AgentTool[] | undefined;

export function agentTools(): AgentTool[] {
  tools ??= createAgentTools({
    withTenant,
    retrieve,
    workspace: async (tenantId) => {
      const site = await tenantSlug(tenantId);
      return createWorkspaceWriter({ baseUrl: workspaceUrl(), site, token: workspaceToken(site) });
    },
  });
  return tools;
}

/** The kill switch and budget for one run. `AGENT_KILL_SWITCH=1` stops every tenant's runs. */
export function agentGuard(viewer: Viewer, env: Record<string, string | undefined> = process.env): RunGuard {
  return createRunGuard({ withTenant, viewer, killedEverywhere: env.AGENT_KILL_SWITCH === "1" });
}
