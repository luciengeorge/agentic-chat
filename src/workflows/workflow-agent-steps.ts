/**
 * Steps for the `WorkflowAgent` comparison (section 16.6). The agent gets the app's own tools and prompt, run as
 * the user, so the comparison is about the loop and nothing else.
 */
import type { ToolSpec } from "#learn/model/types";
import type { Viewer } from "#learn/retrieve/types";

import { runTool, toolSpecs } from "#learn/agent/loop";
import { DELEGATE_TOOL } from "#learn/agent/orchestrate";
import { AGENT_INSTRUCTIONS } from "#learn/agent/prompt";
import { agentRuntime } from "@/lib/agent-runtime";

export interface AgentSetup {
  instructions: string;
  /** Each tool's name, description, JSON Schema, and whether it writes. */
  tools: Array<ToolSpec & { write: boolean }>;
}

/** The app's prompt and tools, as data the workflow body can hold. Sub-agents are left out: they're our runner's. */
export async function setupStep(): Promise<AgentSetup> {
  "use step";
  const tools = (agentRuntime().tools?.() ?? []).filter((t) => t.name !== DELEGATE_TOOL);
  const specs = toolSpecs(tools);
  return {
    instructions: AGENT_INSTRUCTIONS,
    tools: specs.map((spec, i) => ({ ...spec, write: tools[i].effect === "write" })),
  };
}

/**
 * One tool call, as the user, through the app's own `runTool` (validation, timeout, errors as data). The key is
 * WorkflowAgent's call id, which is stable across a replay. What `runTool` would hand our model, this hands back.
 */
export async function runToolStep(
  viewer: Viewer,
  runId: string,
  name: string,
  input: unknown,
  callId: string,
): Promise<unknown> {
  "use step";
  const result = await runTool(
    { callId, tool: name, input },
    {
      tools: agentRuntime().tools?.() ?? [],
      viewer,
      runId,
    },
  );
  return result.ok ? result.output : { error: result.error };
}
