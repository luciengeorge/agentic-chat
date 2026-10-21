/**
 * The shape of a drill (section 20). What a learner may see is `DrillEntry`: an id, a title and the sealed rest.
 * Everything that would point at the answer is in `Fault`, sealed (`./seal`).
 */

/** One exact replacement: `find` must occur exactly once in the file. */
export interface Edit {
  find: string;
  replace: string;
}

export interface FileFault {
  /** Relative to the repo root. */
  path: string;
  edits: Edit[];
}

/**
 * What a drill needs from the running stack before it plants: ParadeDB, fake-workspace, a Cohere key (the real
 * reranker), or a clock that isn't on UTC (a schedule bug that only shows off UTC).
 */
export type Need = "database" | "workspace" | "cohere" | "clock";

/**
 * A change to the running stack. Text in `sql`, and the symptom, may hold `{{...}}` variables (`scripts/ex/drill-live.ts`
 * resolves them once, at plant time, and the journal keeps them for the undo).
 */
export type Action =
  | { kind: "sql"; text: string }
  /** Adds or removes a user's direct membership in fake-workspace's directory. */
  | { kind: "membership"; site: string; group: string; user: string; member: boolean }
  /** Directory sync for the site, in the `ex` process, with the code on disk: `module`'s fetchDirectory and
   * applyDirectory. Modules are named here, sealed, so the clear code that runs them names none. */
  | { kind: "sync-directory"; site: string; module: string };

/** A check that the symptom is gone. Each says what's still wrong when it fails (`explain`). */
export type Probe =
  /** Passes when the query returns no rows. */
  | { kind: "sql-none"; text: string; explain: string }
  /** Passes when the app's own decision (`canRead`) answers `expect` for the user and document. */
  | { kind: "can-read"; site: string; user: string; path: string; expect: boolean; explain: string }
  /** Passes when the app's reranker (`module`'s rerankerFromEnv) scores two short texts without an error. */
  | { kind: "reranker-answers"; module: string; explain: string }
  /** Passes when the code on disk (`module`'s parseCron and nextAfter) fires `cron` once a day at `utc` (HH:MM)
   * for the next `days` days. */
  | { kind: "schedule"; module: string; cron: string; utc: string; days: number; explain: string };

export interface Fault {
  /** What a user or an on-call alert would see. May hold `{{...}}` variables. */
  symptom: string;
  /** The answer, for the solution README and the contract. Never printed by `ex`. */
  cause: string;
  /** Where a good debugger would look, in order. Never printed by `ex`. */
  clues: string[];
  /** The slots (`area/module`) whose reference code the fault changes: a step that slots one would hide it. */
  modules: string[];
  needs: Need[];
  /** Queries that must each return a row before anything changes: the state the drill plants into. */
  requires: { text: string; explain: string }[];
  files: FileFault[];
  plant: Action[];
  /** Puts the stack back. Each action must be safe to repeat, and safe after the learner's own repair. */
  undo: Action[];
  probes: Probe[];
  /** The fault's own test, a Vitest file run from `src/core/drills/check/` against the reference. */
  test: string;
}

export interface DrillEntry {
  id: string;
  title: string;
  /** `Fault`, sealed under the drill's id. */
  sealed: string;
}
