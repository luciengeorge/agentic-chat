/**
 * The same agent on `WorkflowAgent` from `@ai-sdk/workflow` (section 16.6), for comparison. Not wired into the
 * app: the app's runs use `agent-run.ts`. The note in docs/m2-contract.md says what each gives and takes away.
 */
import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";

import { createOpenAI } from "@ai-sdk/openai";
import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@ai-sdk/provider-utils";
import { WorkflowAgent } from "@ai-sdk/workflow";
import { jsonSchema, stepCountIs, type ToolSet, tool } from "ai";
import { getWorkflowMetadata, getWritable } from "workflow";

import { lmStudio } from "#learn/local/lmstudio";
import { localChatConfig, modelProvider } from "#learn/local/provider";

import { runToolStep, setupStep } from "./workflow-agent-steps";

const MODEL_OVERRIDE = Symbol.for("agentic-chat.workflow-agent-model");

/** For tests: the model every `RuntimeModel` call goes to, until called again with null. */
export function setWorkflowAgentModel(model: LanguageModelV4 | null): void {
  (globalThis as Record<symbol, unknown>)[MODEL_OVERRIDE] = model ?? undefined;
}

/**
 * The model, as WorkflowAgent carries it between the workflow and its steps: by name only. The provider's own
 * models serialise their resolved headers, which puts the API key into Workflow's event log on disk, so this one
 * builds the real model inside the step, from the environment. With `MODEL_PROVIDER=local` that's LM Studio's chat
 * model, whatever id it carries, and no OpenAI client is built (section 21).
 */
export class RuntimeModel implements LanguageModelV4 {
  readonly specificationVersion = "v4";
  readonly provider = "agentic-chat";
  readonly supportedUrls = {};

  static [WORKFLOW_SERIALIZE](model: RuntimeModel) {
    return { modelId: model.modelId };
  }

  static [WORKFLOW_DESERIALIZE](options: { modelId: string }) {
    return new RuntimeModel(options.modelId);
  }

  constructor(readonly modelId: string) {}

  private model(): LanguageModelV4 {
    const override = (globalThis as Record<symbol, unknown>)[MODEL_OVERRIDE] as LanguageModelV4 | undefined;
    if (override) return override;
    if (modelProvider() === "local") {
      const config = localChatConfig();
      return lmStudio(config).chatModel(config.chatModel);
    }
    return createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(this.modelId);
  }

  doGenerate(options: LanguageModelV4CallOptions) {
    return this.model().doGenerate(options);
  }

  doStream(options: LanguageModelV4CallOptions) {
    return this.model().doStream(options);
  }
}

/**
 * One request to the agent, as `WorkflowAgent` runs it: the app's prompt and tools, at most 12 model turns. Writes
 * need approval, and `WorkflowAgent` answers that by stopping: the call comes back unanswered, for a client to
 * approve and send again. Nothing goes to `runs` or `run_events`: the run lives in Workflow's own log.
 */
export async function workflowAgentRun(tenantId: string, userId: string, message: string, modelId = "gpt-6-luna") {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();
  const viewer = { tenantId, userId };
  const setup = await setupStep();
  const tools: ToolSet = {};
  for (const spec of setup.tools) {
    tools[spec.name] = tool({
      description: spec.description,
      inputSchema: jsonSchema(spec.inputSchema),
      needsApproval: spec.write,
      execute: (input: unknown, { toolCallId }: { toolCallId: string }) =>
        runToolStep(viewer, workflowRunId, spec.name, input, toolCallId),
    });
  }
  const agent = new WorkflowAgent({
    model: new RuntimeModel(modelId),
    instructions: setup.instructions,
    tools,
    stopWhen: stepCountIs(12),
    // Our planning turn, as far as it goes: the first step must call make_plan. Nothing here can enforce the plan.
    prepareStep: ({ stepNumber }) =>
      stepNumber === 0 && tools.make_plan ? { toolChoice: { type: "tool", toolName: "make_plan" } } : {},
  });
  const result = await agent.stream({ messages: [{ role: "user", content: message }], writable: getWritable() });
  const answered = new Set(result.toolResults.map((r) => r.toolCallId));
  return {
    text: result.steps.at(-1)?.text ?? "",
    steps: result.steps.length,
    tools: result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName)),
    waitingOnApproval: result.toolCalls.filter((call) => !answered.has(call.toolCallId)).map((call) => call.toolName),
    usage: { inputTokens: result.totalUsage.inputTokens, outputTokens: result.totalUsage.outputTokens },
  };
}
