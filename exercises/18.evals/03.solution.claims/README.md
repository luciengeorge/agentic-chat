---
title: Claim decomposition
type: graded
slots:
  eval/claims: claims.ts
---

# Claim decomposition: the solution

`checkMessage` numbers the claims from 1 and puts after each the labels it cited, or every source's label when it cited none, below the sources rendered by `renderSource`. `checkClaims` returns at once for no claims; otherwise it makes one `object` call (`CHECK_INSTRUCTIONS`, the message, `claim_checks`), puts the checks in a `Map` by claim number, and maps every input claim to its check, `not_found` with no evidence when there isn't one, `uncited` when it cited nothing. `scoreClaims` counts the verdicts and divides supported by all claims, 1 for none.

## Why it works

- **Claims localise the failure.** A judge's "unfaithful" says the answer is wrong somewhere. Claim checks say where: Grace's answer has three good claims and one wrong sum, and the evidence quotes the line that says £80. That's what a person fixing a prompt needs.
- **Numbers, not places.** The checker writes its own list. Matching by `claim` number survives a reply out of order or with one missing; matching by position would give claim 2 the verdict meant for claim 3.
- **Silence isn't support.** A skipped claim is `not_found`. The cautious reading costs a little when the checker is lazy; the generous one would let an answer through because the checker didn't look.
- **One call, one reading.** All claims are checked against one rendering of the sources, in one call: 4,042 tokens for Grace's four claims instead of four times that.

## The worked example

Grace's invoice answer: 4 claims, the first citing S1, three uncited and checked against all 8 sources. Supported, supported, contradicted ("The difference is £80.00 plus VAT (2,000 packs at £0.04)"), supported: 0.75. Over the 20 answers, 48 claims in the 19 that make one (2.53 each); the Heron abstention makes none and costs no check call. Mean claim faithfulness: 1.00 on the 8 faithful answers, 0.55 on the 12 unfaithful ones.

## What it misses

Calling an answer faithful only when every claim is supported agrees with the hand labels on 19 of 20. The one it gets wrong is `london-old-limit`: "The hotel limit for a night in London is £180 [[S1: ...]]". The claim cites S1, version 1 of the expenses policy, and S1 does say £180. Only S3 says version 2 replaced it with £200 from 1 July. A check against cited sources can't see a conflict in a source the answer didn't cite.

💯 Fix it: also check each cited claim against the sources it didn't cite, and count `contradicted` there as a failure. Then measure it the way step 4 does, against the hand labels, and see whether it costs you a false alarm somewhere else.
