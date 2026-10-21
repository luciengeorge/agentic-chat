import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, type LinkProps } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import { ChatSidebar } from "@/components/chat/sidebar";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { getOptionalViewer } from "@/lib/auth.functions";
import { viewerMiddleware } from "@/lib/middleware";

/** Reads `.ex/` on this machine, as `ex drill list` does: dev only. */
const getBoard = createServerFn({ method: "GET" })
  .middleware([viewerMiddleware])
  .handler(async () => {
    const { acEnv } = await import("@/lib/env");
    if (acEnv() !== "dev")
      throw new Error(`The drills lab reads this machine's drills, so it only runs in dev (this is ${acEnv()}).`);
    const { drillBoard } = await import("@/components/labs/drills-server");
    return drillBoard(process.cwd());
  });

export const Route = createFileRoute("/labs/drills")({
  beforeLoad: async () => {
    const viewer = await getOptionalViewer();
    if (!viewer) throw redirect({ to: "/login" });
    return { viewer };
  },
  head: () => ({ meta: [{ title: "Drills lab · Kestrel Assistant" }] }),
  component: DrillsLab,
});

const TOOLS: { to: LinkProps["to"]; label: string; what: string }[] = [
  { to: "/labs/acls", label: "Identity and ACLs", what: "anyone's groups, what they can read, the audit row" },
  { to: "/labs/lexical", label: "Lexical and hybrid", what: "one question by BM25, by vectors, fused" },
  { to: "/labs/rerank", label: "Rerank", what: "every candidate before and after the reranker" },
  { to: "/labs/background", label: "Background work", what: "the queue board: jobs and outbox rows" },
  { to: "/labs/connectors", label: "Connectors", what: "fake-workspace's control panel" },
  { to: "/automations", label: "Automations", what: "schedules and triggers, as their owners see them" },
];

function DrillsLab() {
  const { viewer } = Route.useRouteContext();
  const board = useQuery({ queryKey: ["labs", "drills"], queryFn: () => getBoard(), refetchInterval: 5_000 });
  const planted = board.data?.planted;

  return (
    <div className="flex h-svh w-full overflow-hidden">
      <ChatSidebar activeId={undefined} viewer={viewer} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-8">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight">Debugging drills</h1>
            <p className="text-sm text-muted-foreground">
              The report for the planted drill, as a user or an on-call alert would give it, and the tools to find the
              cause. Plant, check and reset with <code className="font-mono">pnpm ex drill</code>, or from each step's
              page in the workshop. Dev only.
            </p>
          </div>

          {board.isError ? <p className="font-mono text-sm text-destructive">{board.error.message}</p> : null}
          {board.isPending ? <Skeleton className="h-32 w-full rounded-xl" /> : null}

          {board.data ? (
            <>
              <section className="flex flex-col gap-3">
                <h2 className="text-sm font-medium">The report</h2>
                {planted ? (
                  <div className="flex flex-col gap-2 rounded-xl border bg-card px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">{planted.title}</span>
                      <Badge>planted</Badge>
                    </div>
                    {planted.symptom ? (
                      <p className="text-sm leading-relaxed whitespace-pre-line">
                        {planted.symptom.replace(/\n(?!\n)/g, " ")}
                      </p>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        It stopped partway: <code className="font-mono">pnpm ex drill reset</code> puts things back.
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No drill is planted. Plant one with <code className="font-mono">pnpm ex drill &lt;id&gt;</code>.
                  </p>
                )}
              </section>

              <section className="flex flex-col gap-3">
                <h2 className="text-sm font-medium">The drills</h2>
                <ul className="flex flex-col divide-y rounded-xl border">
                  {board.data.drills.map((drill) => (
                    <li key={drill.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                      <span className="w-24 shrink-0 font-mono text-xs">{drill.id}</span>
                      {drill.step ? (
                        <Link
                          to="/workshop/$stepId"
                          params={{ stepId: drill.step }}
                          search={{}}
                          className="min-w-0 flex-1 underline-offset-4 hover:underline"
                        >
                          {drill.title}
                        </Link>
                      ) : (
                        <span className="min-w-0 flex-1">{drill.title}</span>
                      )}
                      {drill.planted ? <Badge>planted</Badge> : null}
                      {drill.passed ? (
                        <Badge variant="secondary" className="text-primary">
                          fixed
                        </Badge>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            </>
          ) : null}

          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium">The toolbox</h2>
            <ul className="flex flex-col gap-1.5 text-sm">
              {TOOLS.map((tool) => (
                <li key={tool.label}>
                  <Link to={tool.to} className="font-medium underline-offset-4 hover:underline">
                    {tool.label}
                  </Link>
                  <span className="text-muted-foreground">: {tool.what}</span>
                </li>
              ))}
              <li>
                <a href="/_workflow" className="font-medium underline-offset-4 hover:underline">
                  Workflow's run viewer
                </a>
                <span className="text-muted-foreground">: every run, its steps, and where one failed</span>
              </li>
              <li>
                <code className="font-mono text-xs">docker compose exec paradedb psql -U ac ac</code>
                <span className="text-muted-foreground">: the database, as its owner, every tenant</span>
              </li>
              <li>
                <span className="font-medium">The dev server's terminal</span>
                <span className="text-muted-foreground">: a structured line for each sync, relay pass and run</span>
              </li>
            </ul>
          </section>
        </div>
      </main>
    </div>
  );
}
