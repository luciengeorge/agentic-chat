import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { z } from "zod";

import type { SafetyResult } from "@/components/labs/safety-server";

import { ChatSidebar } from "@/components/chat/sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getOptionalViewer } from "@/lib/auth.functions";
import { viewerMiddleware } from "@/lib/middleware";
import { cn } from "@/lib/utils";

/** The lab acts as other users and stores (then deletes) their notes, so it runs in dev only. */
async function devOnly() {
  const { acEnv } = await import("@/lib/env");
  if (acEnv() !== "dev") {
    throw new Error(
      `The safety lab acts as other users on the dev database, so it only runs in dev (this is ${acEnv()}).`,
    );
  }
}

async function labDeps() {
  const { withTenant } = await import("@/db/tenant");
  const { appDb } = await import("@/db/pool");
  return { withTenant, db: appDb() };
}

const getScenarios = createServerFn({ method: "GET" })
  .middleware([viewerMiddleware])
  .handler(async () => {
    await devOnly();
    const { safetyScenarios } = await import("@/components/labs/safety-server");
    return safetyScenarios();
  });

const runScenarios = createServerFn({ method: "POST" })
  .middleware([viewerMiddleware])
  .validator(z.object({ ids: z.array(z.string().max(100)).max(50) }))
  .handler(async ({ data }): Promise<SafetyResult[]> => {
    await devOnly();
    const { runSafetyScenarios } = await import("@/components/labs/safety-server");
    return runSafetyScenarios(await labDeps(), data.ids);
  });

export const Route = createFileRoute("/labs/safety")({
  beforeLoad: async () => {
    const viewer = await getOptionalViewer();
    if (!viewer) throw redirect({ to: "/login" });
    return { viewer };
  },
  head: () => ({ meta: [{ title: "Safety lab · Kestrel Assistant" }] }),
  component: SafetyLab,
});

function SafetyLab() {
  const { viewer } = Route.useRouteContext();
  const scenarios = useQuery({ queryKey: ["labs", "safety", "scenarios"], queryFn: () => getScenarios() });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const run = useMutation({ mutationFn: (ids: string[]) => runScenarios({ data: { ids } }) });
  const results = run.data ?? [];
  const passed = results.filter((r) => r.passed).length;

  const toggle = (id: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex h-svh w-full overflow-hidden">
      <ChatSidebar activeId={undefined} viewer={viewer} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight">Red-team runner</h1>
            <p className="text-sm text-muted-foreground">
              Each scenario is an attack on the agent's writes, played by a scripted model that obeys it, with every
              approval granted blindly. It runs through <code className="font-mono">#learn/agent/*</code>: your plan,
              policy, guardrails and tools while a section 17 step is active. The documents and people are the dev
              database's; mail and shares go to a fake-workspace inside this request, never the running one. Dev only.
            </p>
          </div>

          {scenarios.isError ? (
            <p className="text-sm text-destructive">{scenarios.error.message}</p>
          ) : !scenarios.data ? (
            <Skeleton className="h-64 w-full rounded-xl" />
          ) : (
            <div className="flex flex-col gap-3">
              <ul className="flex flex-col overflow-hidden rounded-xl border">
                {scenarios.data.map((scenario) => (
                  <li key={scenario.id} className="border-b last:border-b-0">
                    <label className="flex cursor-pointer items-start gap-3 px-3 py-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={picked.has(scenario.id)}
                        onChange={() => toggle(scenario.id)}
                      />
                      <span className="flex min-w-0 flex-col">
                        <span className="font-mono text-xs">{scenario.id}</span>
                        <span>{scenario.title}</span>
                        <span className="text-xs text-muted-foreground">as {scenario.user}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-2">
                <Button disabled={run.isPending || picked.size === 0} onClick={() => run.mutate([...picked])}>
                  Run {picked.size} picked
                </Button>
                <Button variant="outline" disabled={run.isPending} onClick={() => run.mutate([])}>
                  Run all {scenarios.data.length}
                </Button>
              </div>
            </div>
          )}

          {run.isError ? <p className="text-sm text-destructive">{run.error.message}</p> : null}
          {run.isPending ? <Skeleton className="h-48 w-full rounded-xl" /> : null}
          {results.length ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm font-medium tabular-nums">
                {passed} of {results.length} held.
              </p>
              <ol className="flex flex-col gap-2">
                {results.map((result) => (
                  <ResultRow key={result.id} result={result} />
                ))}
              </ol>
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}

function ResultRow({ result }: { result: SafetyResult }) {
  return (
    <li className="flex flex-col gap-2 rounded-xl border px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={result.passed ? "secondary" : "destructive"}>
          {result.passed ? "held" : result.passed === false ? "got through" : "threw"}
        </Badge>
        <span className="font-mono text-xs">{result.id}</span>
        <span className="text-xs text-muted-foreground">
          as {result.user}, {result.outcome}
        </span>
      </div>
      <p>{result.title}</p>
      {result.violation ? <p className="text-destructive">{result.violation}</p> : null}
      {result.error ? <p className="font-mono text-xs text-destructive">{result.error}</p> : null}
      {result.writes.length ? (
        <ul className="flex flex-col gap-1.5">
          {result.writes.map((write, i) => (
            <li key={i} className="flex min-w-0 flex-col gap-0.5">
              <span className="flex items-center gap-2 text-xs">
                <Badge variant={write.outcome === "done" ? "outline" : "secondary"}>
                  {write.outcome === "done" ? "sent" : "refused"}
                </Badge>
                <span className="font-mono">{write.tool}</span>
              </span>
              <span className="line-clamp-2 font-mono text-xs break-all text-muted-foreground">{write.input}</span>
              <span className={cn("text-xs", write.outcome === "done" ? "text-muted-foreground" : "text-foreground")}>
                {write.outcome}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No write attempted.</p>
      )}
    </li>
  );
}
