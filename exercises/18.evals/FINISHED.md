---
title: Evals, done
---

# Evals, done

Kestrel can now say whether a change made the assistant better or worse, and show its working. `hitsLabel` and `judge` match each retrieved chunk to a labelled page, once, so a ranking can't score by repeating itself. `recallAtK`, `reciprocalRank` and `ndcgAtK` turn a ranking into three numbers, each blind where another sees: recall@10 1.000, MRR 0.931 and NDCG@10 0.938 on the golden set. `checkMessage`, `checkClaims` and `scoreClaims` split an answer into claims and check each against the sources it cited, so a wrong sum shows as one claim out of four, not a bare "unfaithful". `observedAgreement`, `chanceAgreement` and `cohensKappa` measure how far to trust the judge: 0.894 against 20 hand labels, where raw agreement would flatter a judge that said the same thing every time. And the agent tasks grade what a run did from its event log, on recordings, on every commit.

The thread through all of it: a measurement is an instrument, and instruments get calibrated. Labels are pages a person can open. The judge is checked against hand labels before it grades anything alone, and the hand labels get checked back: calibration found that `heron-closest` was labelled wrong.

## What to notice in the lab

Run `pnpm dev`, sign in as anyone (`grace.adeyemi@kestrelpay.example`, `dev-password`), and open `/labs/evals`.

- **The golden set**: four runs, each scored again by your code beside what its report recorded. Every row should say "every question matches". The HyDE run's recall drops to 0.988 and routing's to 0.950, as section 08 found.
- **With 18.1 or 18.2 active**, the "Your code" column runs your `metrics.ts`: a stub shows its "isn't written yet", a mistake shows how many questions now score differently.
- **Faithfulness**: the judge's 7, 1, 0, 12 and the claims' 8, 0, 1, 11, side by side, each with its one disagreement. The judge's reason for calling the Heron abstention unfaithful is on its row.
- **With 18.3 or 18.4 active**, the claims column and both kappas are your code.
- **Agent tasks**: four runs, 23 checks, each with what it found.

## What comes next

Section 19 watches the assistant once it runs: a trace for every request with the AI SDK's model spans inside, metrics for tokens, cost and latency, a cost per request from one price table, and every conversation logged through the outbox. Section 20's drills are found with these tools: a ranking that quietly got worse is exactly what the golden set catches.
