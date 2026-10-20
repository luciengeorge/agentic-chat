import { PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

import type { Target } from "./workshop-server";

import { TestResults } from "./test-results";
import { IDLE, readTestEvents, reduceRun, type RunView } from "./test-run";

const CHOICES: { target: Target; label: string }[] = [
  { target: "playground", label: "Playground" },
  { target: "problem", label: "Problem" },
  { target: "solution", label: "Solution" },
];

/** Runs a step's tests through `/workshop/api/run` and shows each test as it ends. */
export function TestRunner({
  stepId,
  active,
  onFinished,
}: {
  stepId: string;
  /** Whether this step is the active one: only then is there a playground to grade. */
  active: boolean;
  onFinished?: (view: RunView) => void;
}) {
  const [picked, setPicked] = useState<Target | null>(null);
  const target = picked ?? (active ? "playground" : "problem");
  const [view, setView] = useState<RunView>(IDLE);
  const running = view.status === "running";

  const run = async () => {
    let latest: RunView = { ...IDLE, status: "running", step: stepId, target };
    setView(latest);
    const fold = (next: RunView) => {
      latest = next;
      setView(next);
    };
    try {
      const response = await fetch("/workshop/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stepId, target }),
      });
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        fold({
          ...latest,
          status: "failed",
          error: { error: `The run didn't start (${response.status}).`, detail: text },
        });
        return;
      }
      await readTestEvents(response.body, (event) => fold(reduceRun(latest, event)));
      if (latest.status === "running") fold({ ...latest, status: "dropped" });
    } catch {
      fold({ ...latest, status: "dropped" });
    }
    onFinished?.(latest);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div role="group" aria-label="Run the tests against" className="flex rounded-lg bg-muted p-0.5">
          {CHOICES.map((choice) => {
            const disabled = choice.target === "playground" && !active;
            return (
              <button
                key={choice.target}
                type="button"
                aria-pressed={target === choice.target}
                disabled={disabled || running}
                title={disabled ? "Start this step to get a playground" : undefined}
                onClick={() => setPicked(choice.target)}
                className={cn(
                  "flex-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors",
                  "hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
                  target === choice.target && "bg-background text-foreground shadow-xs",
                )}
              >
                {choice.label}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          {target === "playground"
            ? "Grades your files in playground/. A pass marks the step done."
            : `Runs the tests on the step's ${target} code, to see what they expect. Your playground isn't touched.`}
        </p>
      </div>
      <Button onClick={run} disabled={running} className="self-start">
        {running ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <HugeiconsIcon icon={PlayIcon} strokeWidth={2} data-icon="inline-start" />
        )}
        {running ? "Running…" : "Run the tests"}
      </Button>
      <TestResults view={view} />
    </div>
  );
}
