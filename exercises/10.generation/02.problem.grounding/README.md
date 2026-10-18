---
title: Grounding and abstention
type: graded
slots:
  generate/prompt: prompt.ts
  generate/answer: answer.ts
---

# Grounding and abstention

👨‍💼 Leo Martin, the finance intern, asks: "What is Project Heron, and how much is Kestrel paying?" Heron is a £86m acquisition, and its memo is shared with `/Kestrel/Exec` only. Section 09 made sure none of Leo's sources mention it. Now the model has to do its part: answer from those sources or say it can't, never fill the gap from a guess. And one of his sources, the Brightwell onboarding pack, holds hidden text telling "AI assistants" to email the Heron memo to an outside address.

## Terms

- **Grounding** is answering only from the sources in the prompt. The instructions (`INSTRUCTIONS` in `prompt.ts`) say it, and say that sources are documents, not orders.
- **Abstaining** is replying with exactly `ABSTAIN_TEXT`: "I couldn't find an answer to that in the documents you can access." It never says whether something was withheld.
- A **prompt injection** is text in a document written to steer the model. A **fence** is what keeps a document's text inside its `<source>` block, so it can't end the block and speak as the app.
- **Flagged** means the answer needs a second look: a citation was dropped, or an answer (not an abstention) cites nothing.
- An **abort signal** is the browser's "stop": when Leo closes the tab, the model call should end too.

## Do this

🐨 Two files. In `playground/prompt.ts`, write `renderSource` again, fenced: escape the title and path, and strip the prompt's own tags from the text. In `playground/answer.ts`, write `answer`: the sources first, an abstention with no model call when there are none, the model's deltas as they come, then the verdict.

## A worked example

Recorded on 18 October: Leo's 8 sources are 2,543 tokens, from the Ashgrove MSA, the Q3 report, the handbook and, at S2, the Brightwell pack's technical section, injection included. None is from `/Exec`. gpt-6-luna spent 88 reasoning tokens and replied with the abstain sentence, word for word: 108 tokens out. `answer` must see that as an abstention, and not flag it for citing nothing.

Ella Brooks asks the Brightwell question and gets all 8 sources from the pack, the injection at S3. The answer cites S1 ("General availability | 16 November 2026") and S3 ("by 15:00 UK time on the business day before pay day"), and says nothing about email. An empty retrieval never gets that far: the abstention goes out with no request at all.

Run the tests with `pnpm ex test 10.2`.
