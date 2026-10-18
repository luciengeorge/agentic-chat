---
title: Generation and citations
---

# Generation and citations

Retrieval hands the chat eight chunks the viewer may read. This section turns them into an answer Kestrel can trust: a prompt that fits, a model told to answer from those chunks and nothing else, a reply that streams to the browser as it's written, and a check on every citation before anyone sees it marked as proof.

The model is the one part of the app that makes things up. So every step here is about holding it to what retrieval found: it sees only labelled sources, it says so when they don't answer, and a citation that doesn't match its source is dropped and the answer flagged.

## Terms

- A **prompt** is everything the model reads for one answer: the **instructions** (the rules, sent as the system message) and the **messages** (earlier turns, then the sources and the question in one user turn).
- A **source** is one retrieved chunk as the prompt shows it: a `<source id="S1" title=... path=... page=...>` block. **S1**, **S2** and so on are its **label**, the short name the model cites it by.
- The **token budget** is how many tokens the sources (6,000) and the earlier turns (1,500) may take. A token is the piece of text a model reads as one item.
- **Grounding** is keeping the answer to what the sources say. **Abstaining** is the assistant saying "I couldn't find an answer to that in the documents you can access." instead of guessing.
- A **prompt injection** is text inside a document that tries to give the model orders. The Brightwell onboarding pack has one, hidden in the file.
- A **citation** is `[[S1: "a quote"]]` in the answer: the label of the source a claim came from, and a short span copied from it. The **validator** keeps a citation only when its label is a source the model saw and its quote is in that source.
- The **UI message stream** is the AI SDK's format for sending an answer to `useChat` in the browser: typed parts (the sources, the text in pieces, the verdict), as server-sent events.

## The steps

1. **Prompt assembly and the token budget** (`generate/prompt.ts`). Fit the sources and the history into their budgets.
2. **Grounding and abstention** (`generate/prompt.ts`, `generate/answer.ts`). Fence each source so a document can't pose as the question, and abstain without a model call when there's nothing to answer from.
3. **Streaming with the AI SDK** (`generate/stream.ts`). Write the answer to the UI message stream as it's written.
4. **The citation validator** (`cite/citations.ts`). Keep a citation only when its quote is really in its source.

The examples are four chat turns recorded once on 18 October 2026 against the dev stack and replayed (`fixtures/cassettes/generate/`), so nothing in this section calls a model: Leo Martin asking for the London hotel limit (two versions of the expenses policy disagree) and about Project Heron (he can't read it), Ella Brooks asking about the Brightwell launch (the injection), and Grace Adeyemi asking why an invoice is on hold (a quote the validator drops). The lab, `/labs/prompt`, replays them through your code.
