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
  return m.categories.reduce((sum, c) => sum + m.counts[c][c], 0) / m.total;
}

/** The agreement luck alone would give: for each category, how often the first rater used it times how often the
 * second did, summed. */
export function chanceAgreement<C extends string>(m: Confusion<C>): number {
  return m.categories.reduce((sum, c) => {
    const byFirst = m.categories.reduce((n, b) => n + m.counts[c][b], 0) / m.total;
    const bySecond = m.categories.reduce((n, a) => n + m.counts[a][c], 0) / m.total;
    return sum + byFirst * bySecond;
  }, 0);
}

/**
 * Cohen's kappa: (observed - chance) / (1 - chance). When chance is already 1 (both raters used one and the same
 * category for everything) there is nothing to beat, and kappa is 1 if they agree.
 */
export function cohensKappa<C extends string>(m: Confusion<C>): number {
  const observed = observedAgreement(m);
  const chance = chanceAgreement(m);
  if (chance === 1) return observed === 1 ? 1 : 0;
  return (observed - chance) / (1 - chance);
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
