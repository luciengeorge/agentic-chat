import { createFileRoute } from "@tanstack/react-router";

import type { ExError, Section, Step } from "@/lib/steps";

import { Badge } from "@/components/ui/badge";
import { getSteps } from "@/lib/get-steps";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({
  loader: () => getSteps(),
  component: Workshop,
});

function Workshop() {
  const result = Route.useLoaderData();

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-16">
      <header className="mb-12">
        <p className="text-sm text-muted-foreground">Agentic Chat</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Workshop</h1>
        {result.ok && <Progress sections={result.data.sections} />}
      </header>

      {result.ok ? <Sections sections={result.data.sections} /> : <Failure error={result.error} />}
    </div>
  );
}

function Progress({ sections }: { sections: Section[] }) {
  const steps = sections.flatMap((section) => section.steps);
  const passed = steps.filter((step) => step.status === "passed").length;
  if (steps.length === 0) return null;
  return (
    <p className="mt-3 text-sm text-muted-foreground tabular-nums">
      {passed} of {steps.length} steps passed
    </p>
  );
}

function Sections({ sections }: { sections: Section[] }) {
  if (sections.length === 0) {
    return <p className="text-sm text-muted-foreground">No steps yet.</p>;
  }
  return (
    <div className="flex flex-col gap-10">
      {sections.map((section) => (
        <section key={section.id} aria-labelledby={`section-${section.id}`}>
          <div className="mb-3 flex items-baseline gap-3">
            <span className="font-mono text-xs text-muted-foreground tabular-nums">{section.id}</span>
            <h2 id={`section-${section.id}`} className="text-base font-medium">
              {section.title}
            </h2>
          </div>
          <ol className="divide-y rounded-lg border">
            {section.steps.map((step) => (
              <StepRow key={step.id} step={step} />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function StepRow({ step }: { step: Step }) {
  return (
    <li
      className={cn("flex items-center gap-4 px-4 py-3", step.status === "active" && "bg-muted/50")}
      aria-current={step.status === "active" ? "step" : undefined}
    >
      <span className="w-10 shrink-0 font-mono text-xs text-muted-foreground tabular-nums">{step.id}</span>
      <span className="min-w-0 flex-1 truncate text-sm">{step.title}</span>
      <Badge variant="outline" className="text-muted-foreground capitalize">
        {step.type}
      </Badge>
      <Status status={step.status} />
    </li>
  );
}

const STATUS = {
  not_started: { label: "Not started", dot: "bg-muted-foreground/30" },
  active: { label: "Current", dot: "ring-2 ring-primary ring-inset" },
  passed: { label: "Passed", dot: "bg-primary" },
} satisfies Record<Step["status"], { label: string; dot: string }>;

function Status({ status }: { status: Step["status"] }) {
  const { label, dot } = STATUS[status];
  return (
    <span
      className={cn(
        "flex w-24 shrink-0 items-center gap-2 text-xs",
        status === "not_started" ? "text-muted-foreground" : "text-foreground",
      )}
    >
      <span aria-hidden className={cn("size-2 rounded-full", dot)} />
      {label}
    </span>
  );
}

function Failure({ error }: { error: ExError }) {
  return (
    <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
      <p className="text-sm font-medium text-destructive">Couldn't list the steps</p>
      <p className="mt-1 text-sm text-muted-foreground">
        <code className="font-mono text-xs">uv run ex list --json</code> failed with{" "}
        <code className="font-mono text-xs">{error.error}</code>.
      </p>
      {error.detail != null && (
        <pre className="mt-3 overflow-x-auto font-mono text-xs whitespace-pre-wrap text-muted-foreground">
          {typeof error.detail === "string" ? error.detail : JSON.stringify(error.detail, null, 2)}
        </pre>
      )}
    </div>
  );
}
