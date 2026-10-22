---
title: "Agents: orchestration"
---

# Agents: orchestration

Sections 13 to 15 built one agent run: a loop, its state in Postgres, and a runner that survives a killed server. Kestrel's assistant now needs more than one run at a time. A chat message has to be sent down the right path. A request that splits in two can hand each half to a helper. A digest has to start itself every Monday, once, and run one agent per new document without flooding anything. **Orchestration** is deciding which runs exist, who starts them, what each may do, and what they cost together.

Autonomous agent orchestration and state management are the course's main goal. This section is the orchestration half, with numbers from this app for each mechanism.

## Terms

- A **workflow** runs steps whose order is written in code; an **agent** lets the model pick each next step (step 1).
- A **router** is one cheap model call that picks a message's path: a plain answer, or an agent run (step 2).
- A **sub-agent** is a child run (`kind: subagent`) that a parent run starts with the `delegate` tool. It acts as the same user, is read-only, and its spend counts against the parent's caps (step 3).
- An **automation** is a prompt that runs as an agent on a **trigger**: a cron schedule or a document landing in a folder. Each firing is a **fire**, named by a **fire key** so it happens once (step 4).
- **Fan-out with backpressure** runs many children with at most N at once, the rest waiting, and stops starting them when the kill switch or a budget says so (step 5).
- **`WorkflowAgent`** is the AI SDK's ready-made agent loop on Vercel Workflow, which step 6 compares with ours.

## The recordings

Made on 19 October 2026 on gpt-6-luna, so nothing in this section calls a model:

- **`router`**: four chat messages through the router, three with no live run and one ("Actually, send it to Amara instead.") with one.
- **`hotels-compare`**: Grace Adeyemi asks to compare what versions 1 and 2 of the travel and expenses policy say about hotels, one sub-agent per version. A parent run and its two children, each with its own log.

## The steps

1. **Workflows vs agents** (guided). Which shape a job takes, read off ingestion, two recorded runs and the automation workflow.
2. **Routing** (`agent/router`: `routeMessage`). A forced tool call picks `answer` or `agent`, and a reply to a live run goes into it.
3. **An orchestrator with sub-agents** (`agent/orchestrate`: `childCaps`, `childStart`, `delegateResult`). Read-only children, each with a share of what the parent has left, and their spend counted against it.
4. **Automations** (`automations/cron`: `latestSlot`; `automations/automation`: `dueSlot`, `dueFire`, `fireRun`). A schedule fires each slot once, however many schedulers see it, and its runs hear only a document's id.
5. **Fan-out with backpressure** (`agent/fanout`: `fanOut`). A fire's runs three at a time, the rest queued, admission before each start.
6. **The same agent on `WorkflowAgent`** (guided). What a framework's loop gives, and what it takes away.

Steps 2, 3 and 5 need nothing running. Step 4's last test and step 6 need Postgres (`pnpm ex up`). The lab, `/labs/orchestration`, draws a run tree: a parent, its children, each child's caps and spend, and what the parent has left.
