import { useMutation } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { z } from "zod";

import type { RerankRow } from "@/components/labs/rerank-server";

import { ChatSidebar } from "@/components/chat/sidebar";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { getOptionalViewer } from "@/lib/auth.functions";
import { scopeOf, viewerMiddleware } from "@/lib/middleware";
import { cn } from "@/lib/utils";

const DEPTHS = ["8", "16", "30", "50"] as const;
const CHAT_K = 8;

const runRerank = createServerFn({ method: "POST" })
  .middleware([viewerMiddleware])
  .validator(z.object({ question: z.string().trim().min(1).max(500), depth: z.number().int().min(1).max(50) }))
  .handler(async ({ context, data }) => {
    const { rerankRun } = await import("@/components/labs/rerank-server");
    const { retrievalDepsFromEnv } = await import("@/lib/retrieval.server");
    const { withTenant } = await import("@/db/tenant");
    const deps = { withTenant, ...retrievalDepsFromEnv() };
    return rerankRun(deps, scopeOf(context.viewer), data.question, data.depth);
  });

export const Route = createFileRoute("/labs/rerank")({
  beforeLoad: async () => {
    const viewer = await getOptionalViewer();
    if (!viewer) throw redirect({ to: "/login" });
    return { viewer };
  },
  head: () => ({ meta: [{ title: "Rerank lab · Kestrel Assistant" }] }),
  component: RerankLab,
});

const pages = (row: RerankRow) =>
  row.pageStart === null
    ? null
    : row.pageEnd !== null && row.pageEnd !== row.pageStart
      ? `pp. ${row.pageStart}-${row.pageEnd}`
      : `p. ${row.pageStart}`;

function Move({ row }: { row: RerankRow }) {
  const move = row.fused - row.reranked;
  return (
    <span
      className={cn(
        "w-12 shrink-0 text-right font-mono text-xs tabular-nums",
        move > 0 ? "text-primary" : move < 0 ? "text-muted-foreground" : "text-muted-foreground/60",
      )}
    >
      {move > 0 ? `▲${move}` : move < 0 ? `▼${-move}` : "="}
    </span>
  );
}

function RerankLab() {
  const { viewer } = Route.useRouteContext();
  const [question, setQuestion] = useState("What is the hotel limit for a night in London?");
  const [depth, setDepth] = useState<(typeof DEPTHS)[number]>("30");
  const run = useMutation({
    mutationFn: () => runRerank({ data: { question, depth: Number(depth) } }),
  });

  return (
    <div className="flex h-svh w-full overflow-hidden">
      <ChatSidebar activeId={undefined} viewer={viewer} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight">Rerank</h1>
            <p className="text-sm text-muted-foreground">
              One search as you, with the reranker watched: every candidate it read, where fusion put it, and where it
              went. Runs <code className="font-mono">#learn/rerank/rerank</code> through retrieval: your code while a
              section 08 step is active.
            </p>
          </div>

          <form
            className="grid grid-cols-[1fr_auto] items-end gap-3 sm:grid-cols-[1fr_auto_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              run.mutate();
            }}
          >
            <Field className="col-span-2 sm:col-span-1">
              <FieldLabel htmlFor="question">Question</FieldLabel>
              <Input id="question" value={question} onChange={(e) => setQuestion(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel>Depth</FieldLabel>
              <Select value={depth} onValueChange={(value) => setDepth(value as (typeof DEPTHS)[number])}>
                <SelectTrigger className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DEPTHS.map((d) => (
                    <SelectItem key={d} value={d}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Button type="submit" disabled={run.isPending || question.trim() === ""}>
              Search
            </Button>
          </form>

          {run.isError ? <p className="font-mono text-sm text-destructive">{run.error.message}</p> : null}
          {run.isPending ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-16 w-full rounded-xl" />
              <Skeleton className="h-16 w-full rounded-xl" />
              <Skeleton className="h-16 w-full rounded-xl" />
            </div>
          ) : run.data ? (
            <section className="flex flex-col gap-3">
              <div className="flex flex-col gap-0.5 text-sm text-muted-foreground">
                <span>
                  <span className="font-mono">{run.data.reranker}</span> read the first {run.data.rows.length} of the
                  candidates you may read. The chat gets the top {CHAT_K}.
                </span>
                {run.data.rewritten.length ? (
                  <span>Also searched: {run.data.rewritten.map((q) => `"${q}"`).join(", ")}</span>
                ) : null}
              </div>
              <ol className="flex flex-col gap-1.5">
                {run.data.rows.map((row) => (
                  <li
                    key={row.id}
                    className={cn(
                      "flex items-start gap-3 rounded-lg border px-3 py-2 text-sm",
                      row.reranked <= CHAT_K ? "bg-card" : "opacity-60",
                      row.reranked === CHAT_K + 1 ? "mt-3" : null,
                    )}
                  >
                    <span className="w-8 shrink-0 font-mono text-xs tabular-nums">#{row.reranked}</span>
                    <span className="w-14 shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                      was #{row.fused}
                    </span>
                    <Move row={row} />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate font-medium">
                        {row.title}
                        {pages(row) ? <span className="font-normal text-muted-foreground"> · {pages(row)}</span> : null}
                      </span>
                      <span className="line-clamp-2 text-xs text-muted-foreground">{row.text}</span>
                    </span>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                      {row.score.toFixed(3)}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
        </div>
      </main>
    </div>
  );
}
