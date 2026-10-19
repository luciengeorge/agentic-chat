import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { z } from "zod";

import type { DurabilityDeps, HeldRunView } from "@/components/labs/durability-server";
import type { Viewer } from "@/lib/auth-server";

import { ChatSidebar } from "@/components/chat/sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getOptionalViewer } from "@/lib/auth.functions";
import { scopeOf, viewerMiddleware } from "@/lib/middleware";

const server = () => import("@/components/labs/durability-server");
const RunInput = z.object({ runId: z.uuid() });

/** The app's runner and the viewer's fake-workspace site. Dev only: it adds faults with the control API. */
async function depsOf(viewer: Viewer): Promise<DurabilityDeps> {
  const { acEnv } = await import("@/lib/env");
  if (acEnv() !== "dev") throw new Error(`The durability lab only runs in dev (this is ${acEnv()}).`);
  const { workspaceToken, workspaceUrl } = await import("@/workflows/sync-common");
  const { runRoutesDeps } = await import("@/routes/api/runs/-deps");
  const { db, kick, wake } = runRoutesDeps();
  const slug = viewer.tenant.slug;
  return {
    db,
    kick,
    wake: wake ?? (async () => {}),
    workspace: {
      baseUrl: workspaceUrl(),
      site: slug,
      token: workspaceToken(slug),
      controlToken: process.env.FAKE_WORKSPACE_CONTROL_TOKEN || undefined,
    },
  };
}

const getRuns = createServerFn({ method: "GET" })
  .middleware([viewerMiddleware])
  .handler(async ({ context }) => {
    const deps = await depsOf(context.viewer);
    return (await server()).listHeldRuns(deps.db, scopeOf(context.viewer));
  });

const getRun = createServerFn({ method: "GET" })
  .middleware([viewerMiddleware])
  .validator(RunInput)
  .handler(async ({ context, data }) =>
    (await server()).heldRun(await depsOf(context.viewer), scopeOf(context.viewer), data.runId),
  );

const startRunFn = createServerFn({ method: "POST" })
  .middleware([viewerMiddleware])
  .handler(async ({ context }) =>
    (await server()).startHeldRun(await depsOf(context.viewer), scopeOf(context.viewer), context.viewer.email),
  );

const approveFn = createServerFn({ method: "POST" })
  .middleware([viewerMiddleware])
  .validator(RunInput)
  .handler(async ({ context, data }) =>
    (await server()).approveHeld(await depsOf(context.viewer), scopeOf(context.viewer), data.runId),
  );

export const Route = createFileRoute("/labs/durability")({
  beforeLoad: async () => {
    const viewer = await getOptionalViewer();
    if (!viewer) throw redirect({ to: "/login" });
    return { viewer };
  },
  head: () => ({ meta: [{ title: "Durability lab · Kestrel Assistant" }] }),
  component: DurabilityLab,
});

const FINAL = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const HOLD_S = 20;
const LEASE_S = 150;

/** What the learner should do or look for now. */
function Guide({ run, offline }: { run: HeldRunView; offline: boolean }) {
  const since = run.approvedAt ? Math.round((Date.parse(run.readAt) - Date.parse(run.approvedAt)) / 1000) : 0;
  let text: string;
  if (offline) {
    text =
      "The dev server isn't answering. If you stopped it, start it again with `pnpm dev`: this page reconnects by itself.";
  } else if (FINAL.has(run.status)) {
    text =
      run.status === "succeeded"
        ? `Done. The run came back on its own and finished, and fake-workspace holds ${run.mails.length} mail${run.mails.length === 1 ? "" : "s"} with its key.`
        : `The run ended ${run.status}. Look at its last events to see why.`;
  } else if (run.approval) {
    text = `The run waits for your approval of ${run.approval.tool}. Approving also holds the send in fake-workspace for ${HOLD_S} s.`;
  } else if (run.approvedAt && run.mails.length === 0 && since < HOLD_S) {
    text = `The send is in flight, held by fake-workspace (${HOLD_S - since} s left). Now stop the dev server: Ctrl+C in the terminal running \`pnpm dev\`. Then run \`pnpm dev\` again.`;
  } else if (run.approvedAt) {
    text = `Approved ${since} s ago. A step that died with the server runs again once its lease runs out (${LEASE_S} s on this machine, 860 s by default), with the same step id, so the same idempotency key.`;
  } else {
    text = "The model is planning the mail. Wait for it to ask for your approval.";
  }
  return <p className="rounded-xl border bg-muted px-4 py-3 text-sm">{text}</p>;
}

function DurabilityLab() {
  const { viewer } = Route.useRouteContext();
  const client = useQueryClient();
  const [picked, setPicked] = useState<string | null>(null);
  const runs = useQuery({ queryKey: ["labs", "durability", "runs"], queryFn: () => getRuns(), refetchInterval: 5_000 });
  const runId = picked ?? runs.data?.[0]?.id ?? null;
  const run = useQuery({
    queryKey: ["labs", "durability", "run", runId],
    queryFn: () => getRun({ data: { runId: runId! } }),
    enabled: runId !== null,
    retry: false,
    refetchInterval: (query) => (query.state.data && FINAL.has(query.state.data.status) ? false : 1_000),
  });
  const refresh = () => client.invalidateQueries({ queryKey: ["labs", "durability"] });
  const start = useMutation({
    mutationFn: () => startRunFn(),
    onSuccess: ({ runId: id }) => setPicked(id),
    onSettled: refresh,
  });
  const approve = useMutation({ mutationFn: (id: string) => approveFn({ data: { runId: id } }), onSettled: refresh });

  const view = run.data ?? null;
  const offline = run.isError && view !== null;
  const error = start.error ?? approve.error ?? runs.error ?? (view ? null : run.error);

  return (
    <div className="flex h-svh w-full overflow-hidden">
      <ChatSidebar activeId={undefined} viewer={viewer} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-8">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight">Agents: durability</h1>
            <p className="text-sm text-muted-foreground">
              A real agent run that sends you one mail. Approve it, kill the dev server while fake-workspace holds the
              send, start it again, and watch the run resume and the mail go out once. Dev only: it adds a latency fault
              to fake-workspace, and it calls the app's model.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={start.isPending} onClick={() => start.mutate()}>
              Start a run
            </Button>
            {(runs.data ?? []).slice(0, 5).map((r) => (
              <Button
                key={r.id}
                size="sm"
                variant={r.id === runId ? "secondary" : "ghost"}
                onClick={() => setPicked(r.id)}
              >
                {r.id.slice(0, 8)} · {r.status}
              </Button>
            ))}
          </div>

          {error ? <p className="text-sm text-destructive">{error.message}</p> : null}

          {runId === null ? null : !view ? (
            run.isPending ? (
              <Skeleton className="h-40 w-full rounded-xl" />
            ) : (
              <p className="text-sm text-muted-foreground">That run isn't yours, or it's gone.</p>
            )
          ) : (
            <section className="flex flex-col gap-3">
              <Guide run={view} offline={offline} />
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={FINAL.has(view.status) ? "outline" : "secondary"}>{view.status}</Badge>
                <span className="text-sm text-muted-foreground tabular-nums">
                  version {view.version} · {view.events.length} events · workflow{" "}
                  <code className="font-mono">{view.workflowRunId ?? "none"}</code>
                </span>
                <span className="flex-1" />
                <Button
                  size="sm"
                  disabled={!view.approval || approve.isPending}
                  onClick={() => approve.mutate(view.runId)}
                >
                  Approve, holding the send {HOLD_S} s
                </Button>
              </div>

              <div className="flex flex-col gap-1.5">
                <h2 className="text-sm font-medium">Mails in fake-workspace with this run&apos;s key</h2>
                {view.mails.length === 0 ? (
                  <p className="text-sm text-muted-foreground">None yet.</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {view.mails.map((mail) => (
                      <li key={mail.idempotencyKey} className="rounded-lg border px-3 py-1.5 font-mono text-xs">
                        {mail.idempotencyKey} · {mail.subject} · {mail.sentAt}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <ol className="flex flex-col gap-1.5">
                {view.events.map((event) => (
                  <li
                    key={event.seq}
                    className="grid grid-cols-[3rem_9rem_1fr] items-start gap-3 rounded-lg border px-3 py-1.5 text-sm"
                  >
                    <span className="font-mono tabular-nums">{event.seq}</span>
                    <span className="font-mono text-xs">{event.type}</span>
                    <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={event.summary}>
                      {event.summary}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
