import { Alert02Icon, CancelCircleIcon, CheckmarkCircle02Icon, MinusSignCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

import type { RunView, TestRow } from "./test-run";

const TARGET_TEXT = { playground: "your playground", problem: "the problem code", solution: "the solution code" };

function Mark({ outcome }: { outcome: TestRow["outcome"] }) {
  switch (outcome) {
    case "pending":
      return <Spinner className="size-4 text-muted-foreground" aria-label="running" />;
    case "passed":
      return (
        <HugeiconsIcon
          icon={CheckmarkCircle02Icon}
          strokeWidth={2}
          className="size-4 text-primary"
          aria-label="passed"
        />
      );
    case "skipped":
      return (
        <HugeiconsIcon
          icon={MinusSignCircleIcon}
          strokeWidth={2}
          className="size-4 text-muted-foreground"
          aria-label="skipped"
        />
      );
    default:
      return (
        <HugeiconsIcon
          icon={CancelCircleIcon}
          strokeWidth={2}
          className="size-4 text-destructive"
          aria-label={outcome === "error" ? "could not run" : "failed"}
        />
      );
  }
}

function summary(view: RunView): string {
  const count = (outcome: TestRow["outcome"]) => view.rows.filter((row) => row.outcome === outcome).length;
  const finished = view.rows.length - count("pending");
  const where = view.target ? ` against ${TARGET_TEXT[view.target]}` : "";
  if (view.status === "running") {
    return view.rows.length
      ? `Running${where}: ${finished} of ${view.rows.length} done`
      : `Starting the tests${where}…`;
  }
  const total = view.rows.length - count("error");
  if (view.passed) return `Passed${where}: ${count("passed")} of ${total} tests`;
  return `Failed${where}: ${count("failed") + count("error")} of ${total} tests`;
}

/** A test run, as it streams and once it's done: each test with its outcome, and each failure's message. */
export function TestResults({ view }: { view: RunView }) {
  if (view.status === "idle") return null;
  const done = view.status === "done";
  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      {view.status === "failed" && view.error ? (
        <div
          role="alert"
          className="flex flex-col gap-1 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm"
        >
          <p className="font-medium text-destructive">{view.error.error}</p>
          {typeof view.error.detail === "string" ? <p className="text-muted-foreground">{view.error.detail}</p> : null}
        </div>
      ) : null}
      {view.status === "dropped" ? (
        <p role="alert" className="rounded-lg border bg-muted px-3 py-2.5 text-sm">
          The connection dropped before the run finished (did the dev server restart?). Run the tests again.
        </p>
      ) : null}
      {view.rows.length || view.status === "running" ? (
        <p
          className={cn(
            "text-sm font-medium",
            done && (view.passed ? "text-primary" : "text-destructive"),
            !done && "text-muted-foreground",
          )}
        >
          {summary(view)}
        </p>
      ) : null}
      {view.rows.length ? (
        <ul className="flex flex-col divide-y rounded-lg border">
          {view.rows.map((row) => (
            <li key={row.nodeid} className="flex flex-col gap-2 px-3 py-2.5" data-outcome={row.outcome}>
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 shrink-0">
                  <Mark outcome={row.outcome} />
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  {row.groups.length ? (
                    <span className="truncate text-xs text-muted-foreground">{row.groups.join(" › ")}</span>
                  ) : null}
                  <span className="text-sm leading-snug">
                    {row.outcome === "error" ? `${row.name} (could not run)` : row.name}
                  </span>
                </div>
              </div>
              {row.message && (row.outcome === "failed" || row.outcome === "error") ? (
                <pre className="ml-6.5 overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground">
                  {row.message}
                </pre>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {view.warnings.map((warning) => (
        <p key={warning} className="flex gap-2 text-sm text-muted-foreground">
          <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="mt-0.5 size-4 shrink-0" />
          {warning}
        </p>
      ))}
    </div>
  );
}
