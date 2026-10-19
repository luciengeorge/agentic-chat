---
title: A typed tool registry
type: graded
slots:
  agent/loop: loop.ts
---

# A typed tool registry: the solution

`toolSpecs` maps each tool to `{ name, description, inputSchema }`, where `inputSchema` is `z.toJSONSchema(tool.input, { io: "input" })` without its `$schema` key. `parseCall` looks the tool up by name ("There is no tool called ..." when it isn't there), runs `safeParse`, and returns either `{ error: "Invalid input: " + z.prettifyError(error) }` or `{ tool, input: parsed.data }`.

## Why it works

- **One schema, two jobs.** What the model is told and what the check accepts come from the same zod object, so they can't drift: a field added to the schema is offered to the model and accepted from it in one change.
- **The input side.** The model sends the input, so the spec describes what may be sent: a field with a default is optional to the sender. (`$schema` is metadata about the schema itself; it isn't a field, and it costs tokens on every request.)
- **A bad input is news, not a crash.** `safeParse` never throws, so a wrong field becomes a failed result the model reads. zod's pretty error names the field and the rule, which is exactly what the model needs to fix it.
- **The parsed value, not the raw one.** zod drops keys the schema doesn't name, so a tool never sees an `adminOverride: true` the model made up.

## The worked example

1,474 tokens of specs on every request, 408 of them `make_plan`'s. Leaving `$schema` in makes it 1,576; describing the output side makes it 1,509, since zod then adds `additionalProperties: false` to every object, and a field with a default becomes required.

The contract number as a document id fails with `Invalid input: ✖ Invalid UUID\n  → at documentId`. The model's next turn sees that as the call's `error-text` output and sends the real id.
