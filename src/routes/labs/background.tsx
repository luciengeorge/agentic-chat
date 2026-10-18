import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { z } from "zod";

import type { BackgroundLabDeps, LabAction } from "@/components/labs/background-server";

import { ChatSidebar } from "@/components/chat/sidebar";
import { DemoJobs, QueueBoard } from "@/components/labs/background-board";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getOptionalViewer } from "@/lib/auth.functions";
import { viewerMiddleware } from "@/lib/middleware";

async function labDeps(): Promise<BackgroundLabDeps> {
  const { withTenant } = await import("@/db/tenant");
  const { systemDb } = await import("@/db/pool");
  return { withTenant, owner: systemDb() };
}
const server = () => import("@/components/labs/background-server");

const getBoard = createServerFn({ method: "GET" })
  .middleware([viewerMiddleware])
  .handler(async ({ context }) => (await server()).board(await labDeps(), context.viewer.tenant.id));

const ACTIONS = ["backfill", "delta", "claim", "finish", "clear"] as const satisfies readonly LabAction[];

const runAction = createServerFn({ method: "POST" })
  .middleware([viewerMiddleware])
  .validator(z.object({ action: z.enum(ACTIONS), capped: z.boolean() }))
  .handler(async ({ context, data }) =>
    (await server()).act(await labDeps(), context.viewer.tenant.id, data.action, data.capped),
  );

export const Route = createFileRoute("/labs/background")({
  beforeLoad: async () => {
    const viewer = await getOptionalViewer();
    if (!viewer) throw redirect({ to: "/login" });
    return { viewer };
  },
  head: () => ({ meta: [{ title: "Background lab · Kestrel Assistant" }] }),
  component: BackgroundLab,
});

function BackgroundLab() {
  const { viewer } = Route.useRouteContext();
  const client = useQueryClient();
  const [capped, setCapped] = useState(true);
  const board = useQuery({ queryKey: ["labs", "background"], queryFn: () => getBoard(), refetchInterval: 2_000 });
  const action = useMutation({
    mutationFn: (name: LabAction) => runAction({ data: { action: name, capped } }),
    onSettled: () => client.invalidateQueries({ queryKey: ["labs", "background"] }),
  });

  return (
    <div className="flex h-svh w-full overflow-hidden">
      <ChatSidebar activeId={undefined} viewer={viewer} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight">Background work</h1>
            <p className="text-sm text-muted-foreground">
              Your tenant's jobs and outbox. Workflow runs (syncs, ingests, agent runs) are in the{" "}
              <a
                href="/_workflow"
                target="_blank"
                rel="noreferrer"
                className="text-primary underline underline-offset-4"
              >
                run viewer
              </a>
              , or run <code className="font-mono">pnpm exec workflow web</code>.
            </p>
          </div>

          {board.isError ? <p className="text-sm text-destructive">{board.error.message}</p> : null}

          <section className="flex flex-col gap-3">
            <div className="flex flex-col gap-0.5">
              <h2 className="text-base font-semibold">The starvation demo</h2>
              <p className="text-sm text-muted-foreground">
                Two workers claim from a queue of their own through{" "}
                <code className="font-mono">#learn/queue/queue</code>. Queue the filing's twelve page ranges, then a
                webhook's delta, then claim, with backfill capped at 1 or not.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" disabled={action.isPending} onClick={() => action.mutate("backfill")}>
                Queue 12 page ranges
              </Button>
              <Button size="sm" variant="outline" disabled={action.isPending} onClick={() => action.mutate("delta")}>
                Queue a delta
              </Button>
              <Button size="sm" disabled={action.isPending} onClick={() => action.mutate("claim")}>
                Idle workers claim
              </Button>
              <Button size="sm" variant="outline" disabled={action.isPending} onClick={() => action.mutate("finish")}>
                Finish running jobs
              </Button>
              <Button size="sm" variant="ghost" disabled={action.isPending} onClick={() => action.mutate("clear")}>
                Clear
              </Button>
              <Button
                size="sm"
                variant={capped ? "secondary" : "ghost"}
                aria-pressed={capped}
                onClick={() => setCapped(!capped)}
              >
                {capped ? "Backfill capped at 1" : "No cap on backfill"}
              </Button>
            </div>
            {action.data?.error ? (
              <p className="font-mono text-sm text-destructive">{action.data.error}</p>
            ) : action.data?.claimed.length ? (
              <p className="text-sm text-muted-foreground">
                {action.data.claimed
                  .map(({ worker, job }) => {
                    const taken = board.data?.jobs.find((j) => j.id === job);
                    return `${worker}: ${taken ? `${taken.class}, ${taken.label}` : job ? "a job" : "nothing it may take"}`;
                  })
                  .join(" · ")}
              </p>
            ) : null}
            {action.error ? <p className="text-sm text-destructive">{action.error.message}</p> : null}
            {board.data ? <DemoJobs jobs={board.data.jobs} /> : <Skeleton className="h-24 w-full rounded-xl" />}
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-base font-semibold">Queue board</h2>
            {board.data ? <QueueBoard cells={board.data.cells} /> : <Skeleton className="h-24 w-full rounded-xl" />}
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-base font-semibold">Outbox</h2>
            {board.data ? (
              <>
                <p className="text-sm text-muted-foreground tabular-nums">
                  {board.data.outbox.pending} pending · {board.data.outbox.published} published, not yet claimed ·{" "}
                  {board.data.outbox.claimed} claimed by a run · {board.data.outbox.failed} failed
                </p>
                <ol className="flex flex-col gap-1.5">
                  {board.data.recentOutbox.map((row) => (
                    <li key={row.id} className="flex items-center gap-3 rounded-lg border px-3 py-1.5 text-sm">
                      <span className="w-14 font-mono text-xs">{row.kind}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                        {row.partitionKey}
                      </span>
                      <span className="text-xs tabular-nums">
                        {row.state}
                        {row.attempts > 1 ? `, ${row.attempts} attempts` : ""}
                      </span>
                    </li>
                  ))}
                </ol>
              </>
            ) : (
              <Skeleton className="h-16 w-full rounded-xl" />
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
