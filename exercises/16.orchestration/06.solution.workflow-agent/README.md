---
title: The same agent on WorkflowAgent
type: guided
---

# The same agent on WorkflowAgent: the comparison

## What the tests show

- **It runs our tools, as the user.** "What's the hotel cap?" takes 2 steps: one `search_documents` call (run through our `runTool`, as Leo), then the answer, "Up to 150 a night." Afterwards the `runs` table holds **0 rows**. The run lives only in Workflow's log.
- **An approval ends the run.** "Mail amara" comes back after **1 step** with `waitingOnApproval: ["send_mail"]` and nothing sent. To carry on, a client must call `stream()` again with an approval message, signed with `experimental_toolApprovalSecret`. Nothing waits; nothing lands in an inbox.
- **The provider's model would leak the key.** Serialised for Workflow's log, `createOpenAI({ apiKey })("gpt-6-luna")` writes its resolved headers, `authorization: Bearer <the key>`, into the log on disk, once per step that receives it. `RuntimeModel` serialises `{ modelId: "gpt-6-luna" }` and builds the real model inside the step from the environment. It's the same rule as everywhere else in Workflow: a step's inputs are written down, so pass ids and names, never secrets or live objects.

## What it gives

Much less code: 146 lines for the workflow and its steps, against `loop.ts` alone at 448. Each model call is a durable step for free, with retries, streaming to `getWritable()`, and a transport for `useChat`. For a short run with read-only tools and nobody waiting, that's the right trade.

## What it takes away

| Need                      | Our runner                                                                              | WorkflowAgent                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| The run's state           | `runs` and `run_events` in Postgres: timeline, inbox, SSE resume by `seq`, any runner   | Workflow's log only                                                                       |
| The plan policy           | `decide` asks the policy before every call; a refusal goes to the model with its reason | `needsApproval` is yes or no; a refusal with a reason would have to live inside each tool |
| Approvals                 | a hook that waits up to 7 days, the decision read back from Postgres                    | the stream ends; the client starts it again                                               |
| Caps, compaction, budget  | `capReached`, `compact`, `holdBudget` before every turn                                 | `stopWhen: stepCountIs(12)`; no token cap, no compaction, no budget                       |
| Follow-ups and sub-agents | `addMessage` into a live run; `delegate` as child workflows, spend counted              | a new `stream()` call; no children                                                        |

## In an interview

"We compared our runtime with the AI SDK's WorkflowAgent on the same prompt and tools. It's a third of the code of our loop alone, and durable per model call. But its state lives only in Workflow's log, so there's no timeline, no inbox and no resume from our event log. Its approval is a yes or no that ends the stream, so plan-then-execute can't refuse a write with a reason, and nothing waits a week for a person. And it has no token caps, compaction or budgets. We kept ours because our runs write and wait on people. We also found that the provider's model serialises its Authorization header into Workflow's log, so we pass a model by name and build it inside the step."
