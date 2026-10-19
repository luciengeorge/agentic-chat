import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { z } from "zod";

import type { LabRun, LogEvent, SendResult } from "@/components/labs/state-server";

import { ChatSidebar } from "@/components/chat/sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { getOptionalViewer } from "@/lib/auth.functions";
import { scopeOf, viewerMiddleware } from "@/lib/middleware";

const server = () => import("@/components/labs/state-server");
const db = async () => (await import("@/db/pool")).appDb();
const RunInput = z.object({ runId: z.uuid() });

const getRuns = createServerFn({ method: "GET" })
  .middleware([viewerMiddleware])
  .handler(async ({ context }) => (await server()).listLabRuns(await db(), scopeOf(context.viewer)));

/** The run's log, read in one statement with its status and version. */
const getLog = createServerFn({ method: "GET" })
  .middleware([viewerMiddleware])
  .validator(RunInput)
  .handler(async ({ context, data }) => (await server()).runLog(await db(), scopeOf(context.viewer), data.runId));

const startLab = createServerFn({ method: "POST" })
  .middleware([viewerMiddleware])
  .handler(async ({ context }) => (await server()).startLabRun(await db(), scopeOf(context.viewer)));

/** Two messages at once, then a resend of the first, through `#learn/agent/messages`. */
const sendTwo = createServerFn({ method: "POST" })
  .middleware([viewerMiddleware])
  .validator(RunInput)
  .handler(async ({ context, data }) =>
    (await server()).sendTwoAtOnce(await db(), scopeOf(context.viewer), data.runId),
  );

const cancelLab = createServerFn({ method: "POST" })
  .middleware([viewerMiddleware])
  .validator(RunInput)
  .handler(async ({ context, data }) => (await server()).cancelLabRun(await db(), scopeOf(context.viewer), data.runId));

export const Route = createFileRoute("/labs/state")({
  beforeLoad: async () => {
    const viewer = await getOptionalViewer();
    if (!viewer) throw redirect({ to: "/login" });
    return { viewer };
  },
  head: () => ({ meta: [{ title: "State lab · Kestrel Assistant" }] }),
  component: StateLab,
});

const FINAL = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

function runLabel(run: LabRun) {
  return `${run.lab ? "Lab run" : run.title || run.kind} · ${run.status} · v${run.version}`;
}

function sendLine({ label, text, result }: SendResult) {
  const outcome =
    result.kind === "added" || result.kind === "duplicate"
      ? `${result.kind} at seq ${result.seq}`
      : result.kind === "error"
        ? `error: ${result.message}`
        : result.kind;
  return `${label} ("${text}"): ${outcome}`;
}

function EventRow({ event }: { event: LogEvent }) {
  const { data } = event;
  return (
    <li className="grid grid-cols-[3rem_3rem_9rem_1fr] items-start gap-3 rounded-lg border px-3 py-1.5 text-sm">
      <span className="font-mono tabular-nums">{event.seq}</span>
      <span className="font-mono text-muted-foreground tabular-nums">v{event.version}</span>
      <span className="font-mono text-xs">{event.type}</span>
      <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={data}>
        {data}
      </span>
    </li>
  );
}

function StateLab() {
  const { viewer } = Route.useRouteContext();
  const client = useQueryClient();
  const [picked, setPicked] = useState<string | null>(null);
  const runs = useQuery({ queryKey: ["labs", "state", "runs"], queryFn: () => getRuns(), refetchInterval: 5_000 });
  const runId = picked ?? runs.data?.[0]?.id ?? null;
  const log = useQuery({
    queryKey: ["labs", "state", "log", runId],
    queryFn: () => getLog({ data: { runId: runId! } }),
    enabled: runId !== null,
    refetchInterval: (query) => (query.state.data?.run && FINAL.has(query.state.data.run.status) ? false : 500),
  });
  const refresh = () => client.invalidateQueries({ queryKey: ["labs", "state"] });
  const start = useMutation({
    mutationFn: () => startLab(),
    onSuccess: ({ runId: id }) => setPicked(id),
    onSettled: refresh,
  });
  const send = useMutation({ mutationFn: (id: string) => sendTwo({ data: { runId: id } }), onSettled: refresh });
  const cancel = useMutation({ mutationFn: (id: string) => cancelLab({ data: { runId: id } }), onSettled: refresh });

  const run = log.data?.run ?? null;
  const live = run !== null && !FINAL.has(run.status);
  const busy = start.isPending || send.isPending || cancel.isPending;
  const error = start.error ?? send.error ?? cancel.error ?? runs.error ?? log.error;

  return (
    <div className="flex h-svh w-full overflow-hidden">
      <ChatSidebar activeId={undefined} viewer={viewer} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-8">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight">Agents: state</h1>
            <p className="text-sm text-muted-foreground">
              One of your runs' event log, read live: each event's seq, the version its append left the run at, its type
              and its data. A lab run has no runner and calls no model: race messages into it through{" "}
              <code className="font-mono">#learn/agent/messages</code>, then cancel it.
            </p>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <Field className="min-w-0 flex-1">
              <FieldLabel>Run</FieldLabel>
              <Select
                value={runId ?? ""}
                onValueChange={(value) => setPicked(value as string)}
                items={(runs.data ?? []).map((r) => ({ value: r.id, label: runLabel(r) }))}
              >
                <SelectTrigger className="w-full min-w-0">
                  <SelectValue placeholder={runs.isPending ? "Loading your runs…" : "No runs yet"} />
                </SelectTrigger>
                <SelectContent>
                  {(runs.data ?? []).map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {runLabel(r)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Button disabled={busy} onClick={() => start.mutate()}>
              Start a lab run
            </Button>
          </div>

          {error ? <p className="text-sm text-destructive">{error.message}</p> : null}

          {runId === null ? null : !log.data ? (
            <Skeleton className="h-40 w-full rounded-xl" />
          ) : !run ? (
            <p className="text-sm text-muted-foreground">That run isn't yours, or it's gone.</p>
          ) : (
            <section className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={live ? "secondary" : "outline"}>{run.status}</Badge>
                <span className="text-sm text-muted-foreground tabular-nums">
                  version {run.version} · {log.data.events.length} events
                </span>
                <span className="flex-1" />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !run.lab || !live}
                  onClick={() => send.mutate(run.id)}
                >
                  Send two messages at once
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || !run.lab || !live}
                  onClick={() => cancel.mutate(run.id)}
                >
                  Cancel
                </Button>
                <a
                  href={`/api/runs/${run.id}/stream`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-primary underline underline-offset-4"
                >
                  Raw stream
                </a>
              </div>
              {!run.lab ? (
                <p className="text-sm text-muted-foreground">
                  A real run: its log tails here as its runner writes. Messages and cancels go through the chat, so its
                  runner hears about them.
                </p>
              ) : null}
              {send.data ? (
                "error" in send.data ? (
                  <p className="text-sm text-destructive">{send.data.error}</p>
                ) : (
                  <ul className="flex flex-col gap-0.5 font-mono text-xs text-muted-foreground">
                    {send.data.sent.map((s) => (
                      <li key={`${s.label}-${s.messageId}`}>{sendLine(s)}</li>
                    ))}
                  </ul>
                )
              ) : null}
              {cancel.data?.error ? <p className="text-sm text-destructive">{cancel.data.error}</p> : null}
              <ol className="flex flex-col gap-1.5">
                {log.data.events.map((event) => (
                  <EventRow key={event.seq} event={event} />
                ))}
              </ol>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
