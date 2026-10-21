---
title: Judge calibration with Cohen's kappa
type: graded
slots:
  eval/kappa: kappa.ts
---

# Judge calibration with Cohen's kappa: the solution

`observedAgreement` adds the diagonal and divides by the total. `chanceAgreement` takes, for each category, the first rater's share (its row summed over the total) times the second rater's share (its column summed over the total), and adds them. `cohensKappa` returns `(observed - chance) / (1 - chance)`, with one guard: when chance is 1, both raters used a single category for everything, and the answer is 1 if they agree, 0 otherwise.

## Why it works

- **Luck has a size, and it depends on habits.** Two raters who both say "faithful" most of the time agree a lot by accident. Multiplying each rater's own rate for a category is what independent raters would hit together; summing over categories is how often they'd land on the same one. That's why the lazy "unfaithful" judge gets 0.6 raw and 0 kappa: luck alone gives it 0.6.
- **The scale is the room above luck.** Dividing by 1 − chance asks what share of the possible improvement over luck the raters reached. The judge reached 0.42 of a possible 0.47. The same raw 0.95 against a chance of 0.9 would be a kappa of 0.5.
- **A judge needs calibrating like any instrument.** It's a model reading the same sources the assistant read, with its own blind spots. Kestrel's judge calls an honest "I couldn't find an answer" unfaithful, and its reason shows why: "the executed MSA says Kestrel pays a fixed platform fee of £61,400 per month, so saying no answer could be found is inaccurate". That fee is Ashgrove's, not Heron's. The judge mixed up "answers the question" with "says only what the sources say", though its instructions say an abstention can be faithful. Kappa over hand labels finds that kind of steady error before the judge grades a thousand answers alone.

## The worked example

7, 1, 0, 12: observed 0.95, chance 0.4 × 0.35 + 0.6 × 0.65 = 0.53, kappa 0.894. The claim checker from step 3 scores 0.898 the same way (chance 0.51), and misses a different answer (`london-old-limit`). Two methods with different blind spots are worth more than either alone.

## Disagreements get read both ways

`heron-closest` says "None of these documents mention Project Heron", then gives a real fact from S1. It was hand-labelled faithful at first. On the first calibration run, both the judge and the claim checker disagreed: S2, the Brightwell pack's planted instructions, does mention the Heron memo. They were right, and the label was changed. With the old label the judge's kappa was 0.794 (18 of 20, chance 0.515); fixing the person's mistake moved it to 0.894. A calibration set is labelled by people, and people are raters too: every disagreement is a question about the label as well as the judge.

💯 Twenty items is small. Work out how far kappa moves if one more item flips either way (19 → 18 agreements, or the chance shifts). That's a feel for its error bars, and why a judge earns trust on more labels before it's used for decisions that matter.
