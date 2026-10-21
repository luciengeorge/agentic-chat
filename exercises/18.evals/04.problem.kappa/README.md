---
title: Judge calibration with Cohen's kappa
type: graded
slots:
  eval/kappa: kappa.ts
---

# Judge calibration with Cohen's kappa

👨‍💼 Claim checks cost two model calls an answer; a judge costs one, and says faithful or unfaithful in a sentence. Kestrel would like to grade every answer in every eval run with it. But a judge is a model, and a model can be wrong in a steady direction: too strict, too lenient, fooled by a confident tone. Before its verdicts count for anything, someone has to measure how often it agrees with a person. That's calibration, and the number it gives is Cohen's kappa.

## Terms

- Two **raters** put the same items into **categories**: here, a person's hand labels and the judge's verdicts, each `faithful` or `unfaithful`, on 20 answers.
- The **confusion matrix** counts each pair: how many items the person put in one category and the judge in another. `counts[a][b]` is "hand said a, judge said b". The **diagonal** (a equals b) is where they agree.
- **Observed agreement** is the share of items on the diagonal.
- **Chance agreement** is how often two raters with these habits would agree by luck alone: for each category, the share of items the first rater put there times the share the second did, added up.
- **Cohen's kappa** = (observed − chance) / (1 − chance): how much of the room above luck the raters actually use. 1 is perfect, 0 is no better than luck, below 0 is worse.

## Do this

🐨 In `playground/kappa.ts`, write `observedAgreement`, `chanceAgreement` and `cohensKappa`. `confusionMatrix` is written.

## A worked example

The judge on gpt-6-luna, against the 20 hand labels:

|                  | judge: faithful | judge: unfaithful | hand total |
| ---------------- | --------------- | ----------------- | ---------- |
| hand: faithful   | 7               | 1                 | 8          |
| hand: unfaithful | 0               | 12                | 12         |
| judge total      | 7               | 13                | 20         |

- Observed: (7 + 12) / 20 = **0.95**.
- Chance: the person says faithful 8 times in 20 (0.4), the judge 7 times (0.35). 0.4 × 0.35 + 0.6 × 0.65 = 0.14 + 0.39 = **0.53**.
- Kappa: (0.95 − 0.53) / (1 − 0.53) = 0.42 / 0.47 = **0.894**. "Almost perfect", on the scale most papers quote.

A judge that answered "unfaithful" every time would agree 12 times in 20 (0.6) and score a kappa of exactly 0. The one disagreement is `heron-recorded`: the assistant's honest "I couldn't find an answer", which the judge called unfaithful. The last tests replay the recorded judge through your code.

Run the tests with `pnpm ex test 18.4`.
