---
title: Streaming with the AI SDK
type: graded
slots:
  generate/stream: stream.ts
---

# Streaming with the AI SDK

👨‍💼 Leo asks for the London hotel limit. gpt-6-luna reasons for a moment, then writes for a few seconds more. Kestrel's chat page shouldn't sit blank all that time: it shows the sources Leo's answer comes from, then the answer word by word, then a citation chip on each claim. The browser's `useChat` hook can draw all of that, if the server sends it in the shape `useChat` reads.

## Terms

- The **AI SDK** (`ai`) has a server half and a browser half. **`useChat`** is the browser half: it sends the question and builds the reply message from what streams back.
- The **UI message stream** is what it reads: **parts**, each a small JSON object sent as a server-sent event. `start` and `finish` frame a message; `text-start`, `text-delta` and `text-end` build one **text part** a piece at a time; a **data part**, `data-<name>`, carries your own data whole.
- The route writes through a **writer** that `createUIMessageStream` hands it: `writer.write(part)`.
- A **`SourceRef`** is a source without its text: label, chunk and document ids, title, path, pages. The **verdict** is the validator's result: citations kept, citations dropped, abstained, flagged.

## Do this

🐨 Write `writeAnswer` in `playground/stream.ts`: for each event of `answer()`, write the parts it stands for, as it arrives, and keep `streamed` up to date. The route (`src/routes/api/chat/-chat.ts`) writes `start` before and `finish` after, and stores `streamed` if Leo leaves halfway.

## A worked example

Leo's recorded answer comes from his 8 sources: version 1 of the expenses policy is S1, version 2's limits table S2, and version 2's "What changed from version 1.0" table S3. gpt-6-luna's reply arrives in **61 text deltas**: "The v2 policy sets the London hotel limit at **£200 per night**. The older version set it at £180." with two citations of S3.

Through your parts, `useChat` builds one message of three parts: `data-sources` with 8 refs (S1 is "Travel and Expenses Policy.pdf", no text), one `text` of all 61 deltas, and `data-verdict` keeping both quotes, "£180 a night | £200 a night" and "Version 2.0 (from 1 July 2026)".

Run the tests with `pnpm ex test 10.3`.
