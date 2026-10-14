import { ArrowRight01Icon, InboxIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { toast } from "sonner";

import type { ToolCall } from "#learn/agent/types";

import { decideApproval, pendingApprovals } from "@/components/agent/api";
import { ApprovalCard, type Decision } from "@/components/agent/approval-card";
import { ChatSidebar } from "@/components/chat/sidebar";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getOptionalViewer } from "@/lib/auth.functions";

export const Route = createFileRoute("/inbox")({
  beforeLoad: async () => {
    const viewer = await getOptionalViewer();
    if (!viewer) throw redirect({ to: "/login" });
    return { viewer };
  },
  head: () => ({ meta: [{ title: "Inbox · Kestrel Assistant" }] }),
  component: InboxPage,
});

function InboxPage() {
  const { viewer } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const approvals = useQuery({ queryKey: ["approvals", "pending"], queryFn: pendingApprovals });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: Decision }) => decideApproval(id, decision),
    onSuccess: (_, { decision }) => toast.success(decision === "approved" ? "Approved" : "Rejected"),
    onError: (error) => toast.error(error.message),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["approvals"] }),
  });

  return (
    <div className="flex h-svh w-full overflow-hidden">
      <ChatSidebar activeId={undefined} viewer={viewer} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight">Inbox</h1>
            <p className="text-sm text-muted-foreground">
              Emails and shares your agent runs want to make. Nothing goes out until you approve it.
            </p>
          </div>

          {approvals.isPending ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-40 w-full rounded-xl" />
              <Skeleton className="h-40 w-full rounded-xl" />
            </div>
          ) : approvals.isError ? (
            <p className="text-sm text-destructive">{approvals.error.message}</p>
          ) : approvals.data.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-12 text-center">
              <HugeiconsIcon icon={InboxIcon} strokeWidth={2} className="size-6 text-muted-foreground" />
              <p className="text-sm font-medium">Nothing waiting for you</p>
              <p className="text-sm text-muted-foreground">Approvals show up here while a run waits on one.</p>
            </div>
          ) : (
            <ul className="flex flex-col gap-4">
              {approvals.data.map((approval) => {
                const call: ToolCall = {
                  callId: approval.callId,
                  tool: approval.tool,
                  input: approval.input,
                  ...(approval.screen ? { screen: approval.screen } : {}),
                };
                return (
                  <li key={approval.id} className="flex flex-col gap-2">
                    <ApprovalCard
                      call={call}
                      expiresAt={approval.expiresAt}
                      decision={null}
                      busy={decide.isPending && decide.variables?.id === approval.id}
                      onDecide={(decision) => decide.mutate({ id: approval.id, decision })}
                    />
                    {approval.conversationId ? (
                      <Link
                        to="/chat/$conversationId"
                        params={{ conversationId: approval.conversationId }}
                        className={buttonVariants({ variant: "link", size: "xs", className: "self-end" })}
                      >
                        Open the conversation
                        <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} data-icon="inline-end" />
                      </Link>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </main>
    </div>
  );
}
