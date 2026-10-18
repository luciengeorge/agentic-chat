---
title: Grounding and abstention
type: graded
slots:
  generate/prompt: prompt.ts
  generate/answer: answer.ts
---

# Grounding and abstention: the solution

`renderSource` runs the title and path through `escapeAttribute` (`&`, `"`, `<`, `>` to entities) and strips `PROMPT_TAG`, `/<\/?\s*(?:sources?|question)\b[^>]*>?/gi`, from the chunk's text before it writes the block.

`answer` builds the prompt and yields its sources. With none, it yields `ABSTAIN_TEXT` as one delta and a `done` with an empty report, `abstained: true`, `finishReason: "abstained"`, and returns before any model call. Otherwise it streams the model, yielding each delta as it arrives and keeping the text and the finish event. At the end, `abstained` is `normalizeAbstention(text) === normalizeAbstention(ABSTAIN_TEXT)`; the citations are validated either way; `flagged` is `!abstained && report.flagged`, and an abstention's report is marked unflagged.

## Why it works

- **The fence holds because the model can't see who wrote what.** Everything in the user turn is characters. The tags are the only thing that says "a document starts here, and ends here". Strip every one of them from document text and only the app can open or close a source, the sources block or the question.
- **It's one layer of several.** The Brightwell injection has no tags; it's prose. The fence keeps it labelled as S3's text, the instructions tell the model sources are documents, and the chat can't send email at all. The model ignored it here; section 17 is about the day one doesn't.
- **Abstaining on nothing is free and safe.** No sources means nothing to ground on, so there's no call to make and no guess to risk, and the fixed sentence leaks nothing about what Leo can't see.
- **An abstention is the sentence alone.** Normalising forgives the model's apostrophes and full stops; comparing the whole text refuses "I couldn't find... but Heron is...", which answered anyway and gets flagged.
- **Streaming is yielding as you go.** Each delta goes out the moment the model sends it, so the browser shows the answer while it's written.

## The worked example

Leo's 8 sources, 2,543 tokens, none from `/Exec`, the Brightwell pack at S2. The recorded reply is `ABSTAIN_TEXT` exactly (108 tokens out, 88 of them reasoning): abstained, not flagged. Ella's 8 Brightwell sources carry the injection at S3; the answer cites S1 and S3 and mentions no email address. With an empty retrieval, the replay records zero requests.
