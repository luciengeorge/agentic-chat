---
title: Generation and citations, done
---

# Generation and citations, done

Every chat answer now runs through code you wrote. Your `fitSources` picks the sources that fit 6,000 tokens and labels them S1 onwards; your `fitHistory` keeps the newest turns that fit. Your `renderSource` fences each one, so a document's text can't close its source or ask its own question. Your `answer` abstains without a call when there's nothing to answer from, streams the model's words as they come, and tells an abstention from an answer. Your `writeAnswer` turns that into the parts `useChat` draws. And your `validateCitations` keeps a citation only when its quote is in the source it names.

None of these make the model honest. They make it checkable: it sees only labelled sources, it's told what to do when they fall short, and every claim it pins to a source is checked against that source before Kestrel shows it.

## What to notice in the lab

Open `/labs/prompt`, signed in as anyone. It replays the four recorded turns through your code, with no model call.

- **london-hotel**: version 1 of the policy is S1 and version 2 is S2 and S3. The reply cites S3 twice, the "what changed" table, which holds both limits in one row. Two citations kept.
- **heron**: 8 sources, none from `/Exec`; S2 is the Brightwell pack, and you can read the injection in the assembled prompt, inside its `<source>`. The reply is the abstain sentence: abstained, not flagged.
- **brightwell**: the injection is in S3. The answer cites S1 and S3 and says nothing about email.
- **invoice-hold**: one citation dropped, `quote-not-found`, and the answer flagged. Set "chunks" to 30: 20 sources fit, 10 are listed as skipped with what they would have cost.
- **london-hotel with a budget of 400**: only S1 and S2 fit (368 tokens), and the recorded reply's two citations of S3 are dropped as `unknown-source`. The replay can't change what the model said, so it shows exactly what your validator does with labels that no longer exist.

## What comes next

Section 11 puts this behind the server boundary: the session decides who is asking, one middleware runs before every route, the request body is checked, a token bucket limits how often, and the stream you wrote here gets heartbeats and stops the model when Leo closes the tab. Section 12 builds the page that reads your parts. Section 17 comes back to the Brightwell injection, for an agent that does have tools.
