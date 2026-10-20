import type { ExFailure, StepRun, Target, TestEvent } from "./workshop-server";

type Outcome = StepRun["tests"][number]["outcome"];

export type TestRow = {
  nodeid: string;
  /** The test's own name, and the `describe` blocks around it. */
  name: string;
  groups: string[];
  outcome: Outcome | "pending";
  message: string | null;
  durationS: number | null;
};

export type RunView = {
  status: "idle" | "running" | "done" | "failed" | "dropped";
  step: string | null;
  target: Target | null;
  rows: TestRow[];
  passed: boolean | null;
  warnings: string[];
  error: ExFailure | null;
};

export const IDLE: RunView = {
  status: "idle",
  step: null,
  target: null,
  rows: [],
  passed: null,
  warnings: [],
  error: null,
};

const ANSI = /\u001b\[[0-9;]*m/g;

/** Plain text: Vitest's colour codes, if any slipped through, would show as junk. */
export const plain = (text: string | null) => (text === null ? null : text.replace(ANSI, ""));

function row(nodeid: string, outcome: TestRow["outcome"], message: string | null, durationS: number | null): TestRow {
  // A file that failed to load has no test name: its nodeid is the file.
  const [, ...titles] = nodeid.split(" > ");
  const name = titles.at(-1) ?? nodeid.split("/").at(-1)!;
  return { nodeid, name, groups: titles.slice(0, -1), outcome, message: plain(message), durationS };
}

function upsert(rows: TestRow[], next: TestRow): TestRow[] {
  const at = rows.findIndex((r) => r.nodeid === next.nodeid);
  return at === -1 ? [...rows, next] : rows.map((r, i) => (i === at ? next : r));
}

/** Folds one streamed event into what the runner shows. The final run's list replaces the streamed one. */
export function reduceRun(view: RunView, event: TestEvent): RunView {
  switch (event.type) {
    case "started":
      return { ...IDLE, status: "running", step: event.step, target: event.target };
    case "collected":
      return {
        ...view,
        rows: event.nodeids.reduce(
          (rows, nodeid) =>
            rows.some((r) => r.nodeid === nodeid) ? rows : [...rows, row(nodeid, "pending", null, null)],
          view.rows,
        ),
      };
    case "test":
      return {
        ...view,
        rows: upsert(view.rows, row(event.test.nodeid, event.test.outcome, event.test.message, event.test.duration_s)),
      };
    case "done":
      return {
        ...view,
        status: "done",
        passed: event.run.passed,
        warnings: event.run.warnings,
        rows: event.run.tests.map((test) => row(test.nodeid, test.outcome, test.message, test.duration_s)),
      };
    case "failed":
      return { ...view, status: "failed", error: event.error };
  }
}

/** Reads a server-sent event stream of `TestEvent`s, skipping the heartbeat comments. */
export async function readTestEvents(body: ReadableStream<Uint8Array>, onEvent: (event: TestEvent) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const data = buffer
        .slice(0, end)
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      buffer = buffer.slice(end + 2);
      if (data) onEvent(JSON.parse(data) as TestEvent);
    }
  }
}
