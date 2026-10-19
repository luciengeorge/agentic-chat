---
title: The same agent on WorkflowAgent
type: guided
---

# The same agent on WorkflowAgent

👨‍💼 Kestrel's agent runtime is hand-built: `decide`, the event log, the policy, approvals that wait a week, caps, compaction, sub-agents. The AI SDK has a ready-made one, `WorkflowAgent`, that runs the same tool loop inside a Vercel Workflow. Before anyone proposes swapping, the team wants to know what it gives and what it takes away. `src/workflows/workflow-agent.ts` runs the app's own prompt and tools on it, so the comparison is about the loop and nothing else.

## Terms

- **`WorkflowAgent`** (from `@ai-sdk/workflow`) is the AI SDK's agent loop as a workflow: each model call is a step, each tool's `execute` can be a step, and a crash replays the finished turns from Workflow's own log.
- **Workflow's event log** is what Workflow keeps on disk (in dev, `.workflow-data/`) for each run: every step's input and output, so it can replay. It's separate from our `run_events` (section 14).
- **Serialising** is turning a value into data that can be written down. Workflow serialises every value a step receives, a model object included, into its log.
- **`needsApproval`** is the AI SDK's way to hold a tool call for a person: it answers yes or no, and a yes stops the loop with the call unanswered.

## Do this

1. 🐨 Run the comparison's tests. They need Postgres (`pnpm ex up`):
   ```sh
   pnpm vitest run src/workflows/workflow-agent.test.ts
   ```
2. 🐨 Read `workflowAgentRun` in `src/workflows/workflow-agent.ts`, and `src/workflows/workflow-agent-steps.ts`. Then compare it with our runner: `agentRunWorkflow` in `src/workflows/agent-run.ts` and `decide` in `src/core/agent/loop.ts`.
3. 🐨 For each, find where our runner does it and say whether `WorkflowAgent` can:
   - show the run on the chat's timeline and stream it to a reloaded page from where it left off (section 14);
   - refuse a `send_mail` the user's plan didn't name, and tell the model why (section 17);
   - wait seven days for Grace to approve a mail, with the request in her inbox (section 15);
   - stop a run at 60,000 tokens, compact its context, or charge her daily budget (sections 13 and 14);
   - take "send it to Amara instead" into a run that's still going (step 2);
   - hand work to a read-only sub-agent whose spend counts against the run (step 3).
4. 🐨 Read `RuntimeModel` and the first test. Why does the comparison pass a model that only knows its name, instead of `createOpenAI(...)(id)`?

🦉 A framework's loop is a good default when the run is short and nothing needs to outlive it: a script, a chat with read-only tools, a prototype. Ours exists because Kestrel's runs write, wait days for people, and have to be explained afterwards. Every one of those needs the run's state in our own tables, with our own rules applied before each step.

📜 [`@ai-sdk/workflow` on npm](https://www.npmjs.com/package/@ai-sdk/workflow), and the [AI SDK docs](https://ai-sdk.dev/docs)
