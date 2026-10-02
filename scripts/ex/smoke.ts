import { findStep } from "./catalog";
import { checkStep } from "./gate";

export type CheckResult = { name: string; passed: boolean; detail: string | null; duration_s: number };
/** Resolves with an optional detail when the check passes; throws when it fails. */
export type Check = () => Promise<string | null>;

export async function runCheck(name: string, check: Check): Promise<CheckResult> {
  const started = performance.now();
  let passed = true;
  let detail: string | null;
  try {
    detail = await check();
  } catch (error) {
    // A smoke check reports every failure, whatever threw it.
    passed = false;
    detail = error instanceof Error ? error.message || error.name : String(error);
  }
  return { name, passed, detail, duration_s: Math.round(performance.now() - started) / 1000 };
}

export function runChecks(checks: [string, Check][]): Promise<CheckResult[]> {
  return Promise.all(checks.map(([name, check]) => runCheck(name, check)));
}

const NOT_INTEGRATED = "not implemented until integration";

// The integrator fills in checks 1 to 5 (docs/m0-contract.md, "`ex smoke` checks").

/** 1. ParadeDB is healthy, has pg_search and vector, and answers a BM25 and a pgvector query. */
async function checkParadeDb(): Promise<string | null> {
  throw new Error(NOT_INTEGRATED);
}

/** 2. leo.martin signs in on :3000 and `/api/me` says kestrel; nina.osei gets harbour. */
async function checkSignIn(): Promise<string | null> {
  throw new Error(NOT_INTEGRATED);
}

/** 3. peter.hall is banned, so his sign-in is refused. */
async function checkBannedUser(): Promise<string | null> {
  throw new Error(NOT_INTEGRATED);
}

/** 4. fake-workspace on :8100: the Heron memo's one grant, Harbour's 403, and /Kestrel/Exec's transitive members. */
async function checkFakeWorkspace(): Promise<string | null> {
  throw new Error(NOT_INTEGRATED);
}

/** 5. The spike workflow starts, waits on its hook, resumes, sleeps, streams and completes. */
async function checkSpikeWorkflow(): Promise<string | null> {
  throw new Error(NOT_INTEGRATED);
}

/** 6. The gate passes on `_smoke.1`: its tests fail on the problem code and pass on the solution. */
async function checkGate(root: string): Promise<string | null> {
  const result = await checkStep(root, findStep(root, "_smoke.1"));
  if (!result.passed) throw new Error(result.reasons.join("; "));
  return null;
}

export function smokeChecks(root: string): [string, Check][] {
  return [
    ["paradedb extensions and queries", checkParadeDb],
    ["sign in and /api/me", checkSignIn],
    ["banned user refused", checkBannedUser],
    ["fake-workspace sharing and directory", checkFakeWorkspace],
    ["spike workflow", checkSpikeWorkflow],
    ["gate on _smoke.1", () => checkGate(root)],
  ];
}
