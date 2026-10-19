---
title: Workflows vs agents
type: guided
---

# Workflows vs agents: what the code shows

## Ingestion is a workflow

`ingestWorkflow` runs, in this order: claim the outbox row, `startIngest`, `storeBlob`, `parseAndChunk` (or, past 500 pages, 12 page-range children for the 3,000-page filing, section 05.5), `embedChunks`, `finishIngest`, then `fireDriveChange`. Seven steps, in the same order for each of Kestrel's 40 documents. Nothing a step returns changes which step comes next, only whether the job stops early (a duplicate, a skipped file, a failure).

A model choosing that order could only get it wrong. Embedding before chunking has nothing to embed; marking a document ready before it's embedded makes it findable with no vectors. And each choice would cost a model turn: Grace's planning turn alone sent 1,865 tokens.

## A request with tools is an agent

Both recordings ask about the same contract, and their steps differ because of what came back:

| Turn | `kpc-terms` (Grace, with a mail)              | `search-timeout` (Grace, no mail)        |
| ---- | --------------------------------------------- | ---------------------------------------- |
| 1    | `make_plan`                                   | `make_plan`                              |
| 2    | `search_documents` and `find_person` together | `search_documents`: timed out after 30 s |
| 3    | `read_document` on the MSA the search found   | `search_documents` again, other words    |
| 4    | `send_mail` (approved)                        | `read_document` on the MSA               |
| 5    | the answer                                    | the answer                               |

`read_document` needs a document id that only exists once a search has returned it. The second search happens only because the first one failed. Nobody could have written either list down in advance. That's the test: the next step depends on what the last one found.

## The digest is both

`automationWorkflow` is a workflow: claim the fire by its key, list the documents, start one run per document three at a time (steps 4 and 5), wait for each. Every one of those steps is known before the fire starts. Each run inside it is an agent, because summarising a document means deciding what to read and whether to look anything up. The same nesting runs the other way in step 3: the parent is an agent, and each `delegate` call starts a child workflow.

## The five jobs

- **Re-ingesting an edited contract:** a workflow. The steps are ingestion's, whatever the contract says.
- **"Email Tom the terms":** an agent. Which document, whether Tom exists, what the terms are: each comes from the step before.
- **The Monday digest:** both. A workflow for the fire, an agent per document.
- **The AP invoice line:** a workflow with one model step. Read the invoice, extract total and supplier with structured output (section 01.4), write the line. The steps are fixed; only the extraction needs a model, and it needs no tools. Making it an agent would add turns and a plan for a job with no choices in it.
- **Does this message need the agent?** A router (step 2): one structured call at 282 to 291 tokens, then a fixed path.

## In an interview

"A workflow when I know the steps up front: cheaper, testable, deterministic. An agent when the next step depends on what the last one returned, and then I bound it with caps and a budget. In our app, ingestion is seven fixed steps; a request to email someone took five model turns whose order came from the search results; and the scheduled digest is a workflow that fans out one agent per document."
