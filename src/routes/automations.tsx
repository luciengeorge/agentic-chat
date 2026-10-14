import { PlayIcon, WorkflowSquare03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { RunView } from "@/components/agent/run-view";
import { type Automation, createAutomation, listAutomations, runNow, setEnabled } from "@/components/automations/api";
import { AutomationForm } from "@/components/automations/automation-form";
import { ChatSidebar } from "@/components/chat/sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getOptionalViewer } from "@/lib/auth.functions";

export const Route = createFileRoute("/automations")({
  beforeLoad: async () => {
    const viewer = await getOptionalViewer();
    if (!viewer) throw redirect({ to: "/login" });
    return { viewer };
  },
  head: () => ({ meta: [{ title: "Automations · Kestrel Assistant" }] }),
  component: AutomationsPage,
});

const KEY = ["automations"];

function when(automation: Automation): string {
  const { trigger } = automation;
  if (trigger.kind === "drive_change") return `When a document in ${trigger.folder} changes`;
  return trigger.folder ? `${trigger.cron} (UTC), over ${trigger.folder}` : `${trigger.cron} (UTC)`;
}

function AutomationItem({ automation }: { automation: Automation }) {
  const queryClient = useQueryClient();
  const [showRun, setShowRun] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: KEY });
  const toggle = useMutation({
    mutationFn: () => setEnabled(automation.id, !automation.enabled),
    onError: (error) => toast.error(error.message),
    onSettled: refresh,
  });
  const run = useMutation({
    mutationFn: () => runNow(automation.id),
    onSuccess: () => toast.success("Started. Its run shows here in a moment."),
    onError: (error) => toast.error(error.message),
    // The fire's run appears once its workflow has claimed it.
    onSettled: () => setTimeout(refresh, 1500),
  });

  return (
    <li className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-medium">{automation.name}</h2>
            <Badge variant={automation.enabled ? "secondary" : "outline"}>{automation.enabled ? "On" : "Off"}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">{when(automation)}</p>
          <p className="line-clamp-2 text-sm text-pretty text-muted-foreground">{automation.prompt}</p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button
            size="sm"
            variant="outline"
            disabled={!automation.enabled || run.isPending}
            onClick={() => run.mutate()}
          >
            <HugeiconsIcon icon={PlayIcon} strokeWidth={2} data-icon="inline-start" />
            Run now
          </Button>
          <Button size="sm" variant="ghost" disabled={toggle.isPending} onClick={() => toggle.mutate()}>
            {automation.enabled ? "Turn off" : "Turn on"}
          </Button>
        </div>
      </div>
      {automation.lastRun ? (
        <div className="flex flex-col gap-2 border-t pt-3">
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              Last run {new Date(automation.lastRun.createdAt).toLocaleString()}: {automation.lastRun.status}
            </span>
            <Button size="xs" variant="ghost" aria-expanded={showRun} onClick={() => setShowRun((v) => !v)}>
              {showRun ? "Hide" : "Show"} the run
            </Button>
          </div>
          {showRun ? <RunView runId={automation.lastRun.id} /> : null}
        </div>
      ) : (
        <p className="border-t pt-3 text-xs text-muted-foreground">It hasn't run yet.</p>
      )}
    </li>
  );
}

function AutomationsPage() {
  const { viewer } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const automations = useQuery({ queryKey: KEY, queryFn: listAutomations, refetchInterval: 15_000 });
  const create = useMutation({
    mutationFn: createAutomation,
    onSuccess: () => toast.success("Automation created"),
    onError: (error) => toast.error(error.message),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: KEY }),
  });

  return (
    <TooltipProvider delay={150}>
      <div className="flex h-svh w-full overflow-hidden">
        <ChatSidebar activeId={undefined} viewer={viewer} />
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8">
            <div className="flex flex-col gap-1">
              <h1 className="text-xl font-semibold tracking-tight">Automations</h1>
              <p className="text-sm text-muted-foreground">
                Prompts the agent runs for you on a schedule, or when a document changes. Each run acts as you.
              </p>
            </div>

            <AutomationForm busy={create.isPending} onCreate={async (body) => void (await create.mutateAsync(body))} />

            {automations.isPending ? (
              <div className="flex flex-col gap-3">
                <Skeleton className="h-28 w-full rounded-xl" />
                <Skeleton className="h-28 w-full rounded-xl" />
              </div>
            ) : automations.isError ? (
              <p className="text-sm text-destructive">{automations.error.message}</p>
            ) : automations.data.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-12 text-center">
                <HugeiconsIcon icon={WorkflowSquare03Icon} strokeWidth={2} className="size-6 text-muted-foreground" />
                <p className="text-sm font-medium">No automations yet</p>
                <p className="text-sm text-muted-foreground">Create one above.</p>
              </div>
            ) : (
              <ul className="flex flex-col gap-4">
                {automations.data.map((automation) => (
                  <AutomationItem key={automation.id} automation={automation} />
                ))}
              </ul>
            )}
          </div>
        </main>
      </div>
    </TooltipProvider>
  );
}
