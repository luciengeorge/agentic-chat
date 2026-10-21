// 👨‍💼 Kestrel wants an LLM judge to grade answers nobody has time to read. First it has to show it agrees with a
//    person far more often than luck would. This file measures that: the eval dashboard and `pnpm eval:judge` call
//    it to compare the judge, and the claim checker, with 20 hand labels.
//
// 🦉 Already written in this file: `confusionMatrix` (the counts, refusing raters who labelled different items)
//    and `describeKappa` (the words for a kappa). You write the three numbers.

/**
 * Agreement between two raters who each put the same items into categories: a person's hand labels and an LLM
 * judge's verdicts, say.
 *
 * Raw agreement (the share of items where both said the same thing) flatters. If 9 answers in 10 are faithful, a
 * judge that says "faithful" every time agrees 90% of the time and has learnt nothing. Cohen's kappa corrects for
 * that: it asks how much better than luck the two raters agree.
 *
 *   kappa = (observed - chance) / (1 - chance)
 *
 * `observed` is the share of items they agree on. `chance` is the agreement two raters would reach by luck alone,
 * if each kept their own habits (how often they use each category) but picked independently: for each category,
 * multiply the two raters' rates of using it, then add those up. So kappa is 1 when they always agree, 0 when they
 * agree no more than luck would, and below 0 when they agree less.
 */

export interface Confusion<C extends string> {
  categories: C[];
  /** `counts[a][b]`: items the first rater put in `a` and the second in `b`. */
  counts: Record<C, Record<C, number>>;
  total: number;
}

function pairUp<C extends string>(first: readonly C[], second: readonly C[]) {
  if (first.length !== second.length) {
    throw new RangeError(`the raters labelled ${first.length} and ${second.length} items; they must label the same`);
  }
  if (first.length === 0) throw new RangeError("no items to compare");
}

/** Counts each pair of labels. The categories are the ones either rater used, unless given (to fix their order). */
export function confusionMatrix<C extends string>(
  first: readonly C[],
  second: readonly C[],
  categories: readonly C[] = [...new Set([...first, ...second])].sort(),
): Confusion<C> {
  pairUp(first, second);
  const counts = Object.fromEntries(
    categories.map((a) => [a, Object.fromEntries(categories.map((b) => [b, 0]))]),
  ) as Record<C, Record<C, number>>;
  for (const [i, a] of first.entries()) {
    const b = second[i];
    if (!(a in counts) || !(b in counts)) throw new RangeError(`label ${a in counts ? b : a} isn't a category`);
    counts[a][b] += 1;
  }
  return { categories: [...categories], counts, total: first.length };
}

/** The share of items both raters put in the same category. */
export function observedAgreement<C extends string>(m: Confusion<C>): number {
  // 🐨 Add up the diagonal, `m.counts[c][c]` for every category, and divide by `m.total`.
  //
  // 🚨 The tests check 15 agreements in 20, two categories and three.
  throw new Error(`observedAgreement(${m.total} items in ${m.categories.length} categories) isn't written yet`);
}

/** The agreement luck alone would give: for each category, how often the first rater used it times how often the
 * second did, summed. */
export function chanceAgreement<C extends string>(m: Confusion<C>): number {
  // 🐨 For each category c: the share of items the first rater put in c (the row of c, summed, over the total),
  //    times the share the second rater put in c (the column of c, summed, over the total). Add those up.
  // 🐨 The classic mistakes: 1 over the number of categories (0.5 for two), which assumes both raters use every
  //    category equally often; and squaring one rater's shares, which forgets the other has habits of its own.
  //    The hand labels say faithful 8 times in 20, the judge 7: chance is 0.4 × 0.35 + 0.6 × 0.65 = 0.53.
  //
  // 🦉 Why multiply. If the two raters chose independently, each keeping its own habits, the chance that both
  //    pick c for the same item is the chance one does times the chance the other does. Adding over the
  //    categories gives the chance they land on the same one by luck.
  // 🦉 Why habits matter. Most answers in a good app are faithful. Two raters that both say "faithful" nine times
  //    in ten agree on 82% of items by luck alone (0.9 × 0.9 + 0.1 × 0.1). Raw agreement of 85% sounds good
  //    and is barely above that.
  //
  // 🚨 The tests check the textbook example, the judge's 0.53, and a matrix whose rows and columns differ.
  throw new Error(`chanceAgreement(${m.total} items in ${m.categories.length} categories) isn't written yet`);
}

/**
 * Cohen's kappa: (observed - chance) / (1 - chance). When chance is already 1 (both raters used one and the same
 * category for everything) there is nothing to beat, and kappa is 1 if they agree.
 */
export function cohensKappa<C extends string>(m: Confusion<C>): number {
  // 🐨 (observed − chance) / (1 − chance), from your two functions.
  // 🐨 When chance is 1 (both raters put every item in the same one category) there's nothing above luck to
  //    measure, and the division is 0 / 0. Return 1, never NaN: chance is 1 only when both raters put every item
  //    in that one category, so they agree on all of it.
  // 🐨 The classic mistake: stopping at observed − chance. That's how far above luck the raters are; dividing by
  //    1 − chance says how much of the possible distance above luck that is, so 1 always means perfect.
  //
  // 🦉 Why kappa and not raw agreement. Raw agreement rewards a lazy judge. One that says "unfaithful" to all 20
  //    answers agrees with the hand labels 12 times (0.6) and has learnt nothing: its kappa is 0. The real judge
  //    agrees 19 times, against a chance of 0.53, and uses 0.42 of the 0.47 above luck: 0.894.
  // 🦉 Why a judge needs calibrating at all. A judge is another model reading the same sources: it can be fooled
  //    by the same confident tone, or hold its own wrong idea of the task. Kestrel's called the honest Heron
  //    abstention unfaithful. Kappa against a small hand-labelled set is how you find that before you trust it on
  //    a thousand answers nobody reads.
  //
  // 🚨 The tests check 0.5, 0 for a lazy judge, 1, −1, chance of 1, three categories, and the judge's 0.894.
  throw new Error(`cohensKappa(${m.total} items in ${m.categories.length} categories) isn't written yet`);
}

/** Landis and Koch's (1977) words for a kappa, the scale most papers quote. */
export function describeKappa(kappa: number): string {
  if (kappa < 0) return "worse than chance";
  if (kappa === 0) return "no better than chance";
  if (kappa <= 0.2) return "slight";
  if (kappa <= 0.4) return "fair";
  if (kappa <= 0.6) return "moderate";
  if (kappa <= 0.8) return "substantial";
  return "almost perfect";
}
