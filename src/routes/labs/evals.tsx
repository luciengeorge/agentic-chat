import type { ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import type { TaskSummary } from "#learn/eval/agent-tasks";
import type { Agreement, EvalsLab, FaithfulnessView, GoldenRow, Part } from "@/components/labs/evals-server";

import { ChatSidebar } from "@/components/chat/sidebar";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { getOptionalViewer } from "@/lib/auth.functions";
import { viewerMiddleware } from "@/lib/middleware";
import { cn } from "@/lib/utils";

/** The eval dashboard through `#learn/eval/*`: the learner's code while a section 18 step is active. */
const loadEvals = createServerFn({ method: "GET" })
  .middleware([viewerMiddleware])
  .handler(async (): Promise<EvalsLab> => {
    const { evalsLab } = await import("@/components/labs/evals-server");
    return evalsLab();
  });

export const Route = createFileRoute("/labs/evals")({
  beforeLoad: async () => {
    const viewer = await getOptionalViewer();
    if (!viewer) throw redirect({ to: "/login" });
    return { viewer };
  },
  head: () => ({ meta: [{ title: "Eval dashboard · Kestrel Assistant" }] }),
  component: EvalsLabPage,
});

const fixed = (n: number, digits = 3) => (Number.isFinite(n) ? n.toFixed(digits) : "–");
const usd = (n: number) => `$${n.toFixed(4)}`;

function EvalsLabPage() {
  const { viewer } = Route.useRouteContext();
  const lab = useQuery({ queryKey: ["labs", "evals"], queryFn: () => loadEvals() });

  return (
    <div className="flex h-svh w-full overflow-hidden">
      <ChatSidebar activeId={undefined} viewer={viewer} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-8">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight">Eval dashboard</h1>
            <p className="text-sm text-muted-foreground">
              Every <code className="font-mono">pnpm eval</code> report, scored again by your{" "}
              <code className="font-mono">#learn/eval/metrics</code>; the judge and the claim checker against 20 hand
              labels; and the agent tasks. All of it runs through <code className="font-mono">#learn/eval/*</code>, your
              code while a section 18 step is active, on files and recordings already on disk. Nothing calls a model.
            </p>
          </div>
          {lab.isError ? (
            <p className="text-sm text-destructive">{lab.error.message}</p>
          ) : !lab.data ? (
            <Skeleton className="h-96 w-full rounded-xl" />
          ) : (
            <>
              <GoldenPanel rows={lab.data.golden} />
              <FaithfulnessPanel part={lab.data.faithfulness} />
              <TasksPanel part={lab.data.agentTasks} />
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-base font-medium">{title}</h2>
        <p className="text-sm text-muted-foreground">{note}</p>
      </div>
      {children}
    </section>
  );
}

function Failed({ error }: { error: string }) {
  return (
    <p className="rounded-xl border border-destructive/40 px-4 py-3 font-mono text-xs text-destructive">{error}</p>
  );
}

function GoldenPanel({ rows }: { rows: GoldenRow[] }) {
  return (
    <Section
      title="The golden set"
      note="Each run as its report recorded it, then its 40 rankings scored again by your judge and metrics (steps 18.1 and 18.2). They should match."
    >
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm tabular-nums">
          <thead className="text-left text-xs text-muted-foreground">
            <tr className="border-b">
              <th className="px-3 py-2 font-medium">Run</th>
              <th className="px-3 py-2 font-medium">recall@10</th>
              <th className="px-3 py-2 font-medium">MRR</th>
              <th className="px-3 py-2 font-medium">NDCG@10</th>
              <th className="px-3 py-2 font-medium">Gates</th>
              <th className="px-3 py-2 font-medium">Answers</th>
              <th className="px-3 py-2 font-medium">Cost</th>
              <th className="px-3 py-2 font-medium">Your code</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((run) => (
              <tr key={run.file} className="border-b last:border-0">
                <td className="px-3 py-2">
                  <span className="flex flex-col">
                    <span>{run.date}</span>
                    <span className="font-mono text-xs text-muted-foreground">{run.mode}</span>
                  </span>
                </td>
                <td className="px-3 py-2">{fixed(run.recallAt10)}</td>
                <td className="px-3 py-2">{fixed(run.mrr)}</td>
                <td className="px-3 py-2">{fixed(run.ndcgAt10)}</td>
                <td className="px-3 py-2">
                  <Badge variant={run.gatesPassed ? "secondary" : "destructive"}>
                    {run.gatesPassed ? "pass" : "fail"}
                  </Badge>
                </td>
                <td className="px-3 py-2">{run.answers ? `${run.answers.passed} of ${run.answers.total}` : "–"}</td>
                <td className="px-3 py-2">{usd(run.costUsd)}</td>
                <td className="px-3 py-2">
                  {run.rescored.ok ? (
                    <span className="flex flex-col gap-0.5">
                      <span>
                        {fixed(run.rescored.value.recallAt10)} / {fixed(run.rescored.value.mrr)} /{" "}
                        {fixed(run.rescored.value.ndcgAt10)}
                      </span>
                      {run.rescored.value.differ.length ? (
                        <span className="text-xs text-destructive">
                          {run.rescored.value.differ.length} differ: {run.rescored.value.differ.slice(0, 3).join(", ")}
                          {run.rescored.value.differ.length > 3 ? "…" : ""}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">every question matches</span>
                      )}
                    </span>
                  ) : (
                    <span className="font-mono text-xs text-destructive">{run.rescored.error}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function AgreementCard({ title, a }: { title: string; a: Agreement }) {
  const cell = "px-3 py-1.5 text-right";
  return (
    <div className="flex flex-col gap-3 rounded-xl border px-4 py-3 text-sm">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium">{title}</span>
        <span className="tabular-nums">
          kappa <span className="font-semibold">{fixed(a.kappa)}</span>{" "}
          <span className="text-muted-foreground">({a.words})</span>
        </span>
      </div>
      <table className="text-xs tabular-nums">
        <thead className="text-muted-foreground">
          <tr>
            <th className="px-3 py-1.5 text-left font-normal">hand ↓ / verdict →</th>
            <th className={cn(cell, "font-normal")}>faithful</th>
            <th className={cn(cell, "font-normal")}>unfaithful</th>
          </tr>
        </thead>
        <tbody>
          {(["faithful", "unfaithful"] as const).map((hand) => (
            <tr key={hand}>
              <td className="px-3 py-1.5 text-muted-foreground">{hand}</td>
              {(["faithful", "unfaithful"] as const).map((verdict) => (
                <td
                  key={verdict}
                  className={cn(
                    cell,
                    hand === verdict
                      ? "font-semibold"
                      : a.counts[hand][verdict] > 0
                        ? "text-destructive"
                        : "text-muted-foreground",
                  )}
                >
                  {a.counts[hand][verdict]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted-foreground tabular-nums">
        Observed {fixed(a.observed, 2)}, chance {fixed(a.chance, 2)}. Disagree on{" "}
        <span className="font-mono">{a.disagreements.join(", ") || "nothing"}</span>.
      </p>
    </div>
  );
}

function FaithfulnessPanel({ part }: { part: Part<FaithfulnessView | null> }) {
  return (
    <Section
      title="Faithfulness against the hand labels"
      note="The judge (one verdict an answer) and the claims method (faithful only when every claim is supported, step 18.3), each compared with 20 hand labels by Cohen's kappa (step 18.4)."
    >
      {!part.ok ? (
        <Failed error={part.error} />
      ) : !part.value ? (
        <p className="text-sm text-muted-foreground">
          The judge and claim recordings aren't in fixtures/cassettes/eval.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <AgreementCard title="Judge" a={part.value.judge} />
            <AgreementCard title="Claims" a={part.value.claims} />
          </div>
          <p className="text-sm text-muted-foreground tabular-nums">
            {fixed(part.value.claimsPerAnswer, 2)} claims an answer. Mean claim faithfulness{" "}
            {fixed(part.value.meanFaithfulness.faithful, 2)} on the hand-faithful answers,{" "}
            {fixed(part.value.meanFaithfulness.unfaithful, 2)} on the unfaithful ones.
          </p>
          <ul className="flex flex-col divide-y rounded-xl border text-sm">
            {part.value.items.map((item) => {
              const judgeOff = item.judge.verdict !== item.label;
              const claimsOff = item.claimsVerdict !== item.label;
              return (
                <li key={item.id} className="flex flex-col gap-1 px-4 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs">{item.id}</span>
                    <Badge variant="outline">hand: {item.label}</Badge>
                    <Badge variant={judgeOff ? "destructive" : "secondary"}>judge: {item.judge.verdict}</Badge>
                    <Badge variant={claimsOff ? "destructive" : "secondary"}>
                      claims: {item.score.supported} of {item.score.claims} supported
                    </Badge>
                  </div>
                  {judgeOff ? <p className="text-xs text-muted-foreground">Judge: {item.judge.reason}</p> : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Section>
  );
}

function TasksPanel({ part }: { part: Part<TaskSummary> }) {
  return (
    <Section
      title="Agent tasks"
      note="Four recorded agent runs replayed through the loop, each graded by checks over its event log (step 18.5)."
    >
      {!part.ok ? (
        <Failed error={part.error} />
      ) : (
        <ul className="flex flex-col gap-2">
          {part.value.tasks.map((task) => (
            <li key={task.id} className="flex flex-col gap-2 rounded-xl border px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs">{task.id}</span>
                <Badge variant={task.passed ? "secondary" : "destructive"}>
                  {task.checks.filter((c) => c.passed).length} of {task.checks.length}
                </Badge>
                <span className="text-muted-foreground">{task.title}</span>
              </div>
              <ul className="flex flex-col gap-0.5 text-xs">
                {task.checks.map((check, i) => (
                  <li key={i} className={cn("flex gap-2", check.passed ? "text-muted-foreground" : "text-destructive")}>
                    <span>{check.passed ? "✓" : "✗"}</span>
                    <span>
                      {check.description}: {check.detail}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
