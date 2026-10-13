import type { Label } from "./metrics";

/**
 * What an answer has to do. An `answer` case must answer, cite at least one labelled document and say nothing it
 * mustn't; an `abstain` case must abstain.
 */
export type Expectation = "answer" | "abstain";

export interface AnswerOutcome {
  text: string;
  abstained: boolean;
  /** The documents the answer's valid citations point at. */
  citedPaths: string[];
}

export interface CheckResult {
  passed: boolean;
  reasons: string[];
}

const squash = (text: string) => text.replace(/\s+/g, " ").toLowerCase();

/** The strings in `needles` that appear in `text`, ignoring case and runs of whitespace. */
export function mentions(text: string, needles: readonly string[]): string[] {
  const haystack = squash(text);
  return needles.filter((needle) => haystack.includes(squash(needle)));
}

export function checkAnswer(expect: Expectation, labels: Label[], outcome: AnswerOutcome): CheckResult {
  const reasons: string[] = [];
  if (expect === "abstain") {
    if (!outcome.abstained) reasons.push("answered instead of abstaining");
    return { passed: reasons.length === 0, reasons };
  }
  if (outcome.abstained) reasons.push("abstained");
  const labelled = new Set(labels.map((label) => label.path));
  if (!outcome.citedPaths.some((path) => labelled.has(path))) {
    reasons.push(
      outcome.citedPaths.length === 0
        ? "cited nothing"
        : `cited no labelled document (cited ${[...new Set(outcome.citedPaths)].join(", ")})`,
    );
  }
  return { passed: reasons.length === 0, reasons };
}

export interface Retrieved {
  documentId: string;
  path: string;
}

export interface GateInput {
  /** The asking user's tenant. */
  tenantId: string;
  /** Every chunk retrieval returned, whether or not the model saw it. */
  retrieved: Retrieved[];
  citedPaths: string[];
  /** The answer, or null in a retrieval-only run. */
  text: string | null;
  /** Text this user must never be shown (`forbidden` and `hidden` in the golden set). */
  secrets: readonly string[];
}

export interface GateOracle {
  /** The tenant a document belongs to, from the database as its owner sees it; undefined when it isn't there. */
  tenantOf(documentId: string): string | undefined;
  /** Whether the user may read the document at this path, decided from the world and the manifest. */
  canRead(path: string): boolean;
}

export interface GateResult {
  leaks: string[];
  crossTenant: string[];
}

/**
 * The hard gates for one question: no chunk or citation from a document the user can't read, no secret in the
 * answer, and nothing from another tenant. The oracle is independent of the app's own ACL code, so a bug there
 * can't excuse itself.
 */
export function checkGates(input: GateInput, oracle: GateOracle): GateResult {
  const leaks = new Set<string>();
  const crossTenant = new Set<string>();
  for (const chunk of input.retrieved) {
    const tenant = oracle.tenantOf(chunk.documentId);
    if (tenant !== input.tenantId) {
      crossTenant.add(chunk.path);
      continue;
    }
    if (!oracle.canRead(chunk.path)) leaks.add(`retrieved ${chunk.path}`);
  }
  for (const path of input.citedPaths) if (!oracle.canRead(path)) leaks.add(`cited ${path}`);
  if (input.text !== null) for (const secret of mentions(input.text, input.secrets)) leaks.add(`said "${secret}"`);
  return { leaks: [...leaks], crossTenant: [...crossTenant] };
}
