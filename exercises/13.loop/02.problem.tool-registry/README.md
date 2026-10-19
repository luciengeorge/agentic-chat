---
title: A typed tool registry
type: graded
slots:
  agent/loop: loop.ts
---

# A typed tool registry

👨‍💼 The model writes every tool input itself, and it can get one wrong: the contract number "KPC-2026-0142" where `read_document` wants a document id, a `k` of 12 when search returns 8 at most. Kestrel's tools are typed with zod, so one schema can tell the model what a tool takes and check what it sends. A bad input then costs one turn: the model reads exactly what was wrong and tries again.

## Terms

- **zod** is the library the app writes schemas in. `safeParse` checks a value against a schema and says what's wrong without throwing.
- **JSON Schema** is the format OpenAI reads tool inputs in. `z.toJSONSchema` turns a zod schema into one.
- The **registry** is the list of tools a run may use (`AgentTool[]`): name, description, input schema, read or write, and the function that runs it.
- A **`ToolSpec`** is what the model sees of a tool: its name, its description and its input as JSON Schema.
- **Strict mode** is OpenAI holding the model to the schema. It wants every property required, so the app's optional fields are `.nullable()`.

## Do this

🐨 In `playground/loop.ts`, write `toolSpecs` (the registry as the model sees it) and `parseCall` (find the call's tool, check its input). `runTool` and `approvalNeeded` already call `parseCall`.

## A worked example

The app's six tools come to 1,474 tokens of specs (`make_plan` is the biggest at 408), sent with every request: Grace's five turns sent them five times.

Suppose the model calls `read_document` with `{ "documentId": "KPC-2026-0142", "fromChunk": null }`. `parseCall` answers `Invalid input: ✖ Invalid UUID → at documentId` (with a newline before the arrow), the tool never runs, and the call's result says so. On its next turn the model reads that and sends the MSA's id, `ab8c3047-...`, and the read succeeds. A `fromChunk` of `"3"` gets `expected number, received string → at fromChunk`; a `k` of 12 gets `Too big: expected number to be <=8 → at k`.

Run the tests with `pnpm ex test 13.2`.
