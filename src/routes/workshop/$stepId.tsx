import { LinkSquare02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import type { DrillCommand, SwapCommand } from "@/components/workshop/workshop-server";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { DrillPanel } from "@/components/workshop/drill-panel";
import { HintsPanel } from "@/components/workshop/hints-panel";
import { Readme } from "@/components/workshop/readme";
import { SolutionDiff } from "@/components/workshop/solution-diff";
import { StepActions, StepLink, SwapStatus, useSwapJob } from "@/components/workshop/swap";
import { TestRunner } from "@/components/workshop/test-runner";

import { checkDrillFn, getDiff, startDrillFn, startSwapFn } from "./-functions";
import { stepQuery } from "./-queries";

export const Route = createFileRoute("/workshop/$stepId")({
  validateSearch: (search: Record<string, unknown>): { job?: string } =>
    typeof search.job === "string" ? { job: search.job } : {},
  loader: async ({ context, params }) => {
    if (context.gate.state === "ok") await context.queryClient.ensureQueryData(stepQuery(params.stepId));
  },
  head: ({ params }) => ({ meta: [{ title: `${params.stepId} · Workshop · Kestrel Assistant` }] }),
  component: StepPage,
  notFoundComponent: () => (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-6 py-14">
      <h1 className="text-xl font-semibold tracking-tight">No such step</h1>
      <p className="text-sm text-muted-foreground">
        The list on the left has every step. A step still being written (no README or no solution yet) isn't listed.
      </p>
    </main>
  ),
});

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h2>
      {children}
    </section>
  );
}

const TYPE_TEXT = {
  graded: "graded: the tests decide when you're done",
  guided: "guided: a walkthrough, with no pass or fail",
  lab: "lab: done when the README's result shows in the app",
};

function StepPage() {
  const { stepId } = Route.useParams();
  const { job: jobId } = Route.useSearch();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { data: page } = useSuspenseQuery(stepQuery(stepId));
  const job = useSwapJob(jobId);
  const [sending, setSending] = useState(false);
  const { step } = page;
  const active = step.status === "active";
  const switching =
    !!jobId && (job.data === undefined || job.data.state === "running" || job.data.state === "switching");

  const swap = async (command: SwapCommand, target = step.id, force = false) => {
    setSending(true);
    try {
      const { jobId: id, busy } = await startSwapFn({ data: { command, stepId: target, force } });
      if (busy) toast.error(busy);
      else await navigate({ to: "/workshop/$stepId", params: { stepId: target }, search: { job: id! } });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The switch didn't start.");
    } finally {
      setSending(false);
    }
  };

  const drillJob = async (command: DrillCommand) => {
    setSending(true);
    try {
      const { jobId: id, busy } = await startDrillFn({ data: { command, stepId: step.id } });
      if (busy) toast.error(busy);
      else await navigate({ to: "/workshop/$stepId", params: { stepId: step.id }, search: { job: id! } });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The drill didn't start.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-12 px-6 py-10 md:py-12 lg:flex-row lg:gap-14">
      <article className="flex min-w-0 flex-1 flex-col gap-8">
        {jobId ? (
          <SwapStatus
            job={job.data}
            onDismiss={() => navigate({ to: "/workshop/$stepId", params: { stepId }, search: {} })}
            onForce={(target) => swap("start", target, true)}
          />
        ) : null}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <Link
            to="/workshop/sections/$sectionId"
            params={{ sectionId: page.section.id }}
            className="transition-colors hover:text-foreground"
          >
            {page.section.id} {page.section.title}
          </Link>
          <span aria-hidden>/</span>
          <span className="tabular-nums">Step {step.id}</span>
          <Badge variant="outline" title={TYPE_TEXT[step.type]}>
            {step.type}
          </Badge>
          {active ? <Badge>active</Badge> : null}
          {step.passed ? (
            <Badge variant="secondary" className="text-primary">
              passed
            </Badge>
          ) : null}
        </div>
        <Readme text={page.readme} />
        {page.files.length ? (
          <section className="flex flex-col gap-4 border-t pt-8">
            <h2 className="text-lg font-semibold tracking-tight">Compare with the solution</h2>
            {active ? (
              <SolutionDiff key={step.id} stepId={step.id} load={(id) => getDiff({ data: { stepId: id } })} />
            ) : (
              <p className="text-sm text-muted-foreground">
                Start this step to compare your playground with its solution.
              </p>
            )}
          </section>
        ) : null}
        {page.previous || page.next ? (
          <nav aria-label="Steps" className="flex gap-3 border-t pt-8">
            {page.previous ? <StepLink {...page.previous} direction="previous" /> : <span className="flex-1" />}
            {page.next ? <StepLink {...page.next} direction="next" /> : <span className="flex-1" />}
          </nav>
        ) : null}
      </article>

      <aside className="flex w-full flex-col gap-10 lg:w-80 lg:shrink-0">
        <Panel title="This step">
          <StepActions step={step} files={page.files} busy={sending || switching} onSwap={(command) => swap(command)} />
          {page.lab ? (
            <a href={page.lab} className={buttonVariants({ variant: "outline", size: "sm", className: "self-start" })}>
              <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={2} data-icon="inline-start" />
              Open the lab
            </a>
          ) : null}
        </Panel>
        {page.drill ? (
          <Panel title="Drill">
            <DrillPanel
              key={`${page.drill.id}-${page.drill.planted}`}
              drill={page.drill}
              busy={sending || switching}
              onPlant={() => drillJob("plant")}
              onReset={() => drillJob("reset")}
              check={async () => {
                const outcome = await checkDrillFn();
                void client.invalidateQueries({ queryKey: ["workshop"] });
                return outcome;
              }}
            />
          </Panel>
        ) : null}
        <Panel title="Tests">
          {page.drill ? (
            <p className="text-sm leading-relaxed text-muted-foreground">
              A drill is graded by <code>pnpm ex drill check</code>, the Check button above: the symptom gone, and the
              fault's own test passing.
            </p>
          ) : step.type === "graded" ? (
            <TestRunner
              key={`${step.id}-${active}`}
              stepId={step.id}
              active={active}
              onFinished={(run) => {
                if (run.target === "playground" && run.passed)
                  void client.invalidateQueries({ queryKey: ["workshop"] });
              }}
            />
          ) : (
            <p className="text-sm leading-relaxed text-muted-foreground">
              A {step.type} step has no tests.{" "}
              {step.type === "lab" ? "The README says what to look for in the app." : "Read along and try it."}
            </p>
          )}
        </Panel>
        <Panel title="Hints">
          <HintsPanel hints={page.hints} files={page.files} />
        </Panel>
      </aside>
    </div>
  );
}
