---
title: Claim decomposition
type: graded
slots:
  eval/claims: claims.ts
---

# Claim decomposition

👨‍💼 Steps 1 and 2 grade retrieval: were the right pages found? They can't see what the model then wrote. Grace Adeyemi, in accounts payable, asks why the Brindle invoice is on hold, and an answer can rest on the right page and still get the sum wrong. Kestrel wants to know, for every answer, which parts the sources back and which they don't. So the answer is split into claims, and each claim is checked against the sources it cited.

## Terms

- A **claim** is one fact that's true or false on its own: "Brindle charged £1.62 a welcome pack". "The limit rose from £180 to £200" is two.
- **Decomposing** an answer asks a model to split it into claims, each with the source labels the answer cited for it (`S1`). `decomposeClaims` does it, already written.
- **Checking** asks a model, for each claim, whether its sources make it `supported`, `contradicted` or `not_found` (they don't say). A claim that cited nothing is checked against every source and marked **uncited**.
- **Claim faithfulness** is the share of an answer's claims that are supported. An answer with no claims (an abstention) has nothing false in it: 1.
- The **recordings** (`fixtures/cassettes/eval/claims.json`) hold both calls for each of the 20 hand-labelled answers, made on gpt-6-luna. The tests replay them: an item's nth call gets its nth recorded reply.

## Do this

🐨 In `playground/claims.ts`, write `checkMessage` (the claims, numbered, each with the sources it may be checked against), `checkClaims` (one call for every claim) and `scoreClaims`.

## A worked example

Grace's question, answered with one number wrong: "Brindle charged £1.62 a welcome pack against the £1.58 in the PO, and on 2,000 packs that comes to £800 plus VAT, so AP put it on hold. [[S1: ...]]". Decomposed, it's four claims. The first cites S1; the other three cite nothing, so they're checked against all 8 sources:

1. Brindle charged £1.62 a welcome pack. **supported** (S1)
2. The PO was for £1.58 a welcome pack. **supported**, uncited
3. On 2,000 packs, the difference comes to £800 plus VAT. **contradicted**, uncited: "The difference is £80.00 plus VAT (2,000 packs at £0.04)."
4. AP put the invoice on hold because of the difference. **supported**, uncited

3 of 4: claim faithfulness **0.75**, and the report can say which claim failed. Over the 20 answers it's 48 claims in the 19 that make one (2.53 an answer), a mean of 1.00 on the 8 hand-labelled faithful and 0.55 on the 12 unfaithful. The last tests replay all of it through your code.

Run the tests with `pnpm ex test 18.3`.
