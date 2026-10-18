import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { childRunId, DELEGATE_TOOL } from "#learn/agent/orchestrate";
import { useRunStream } from "#learn/frontend/run-stream";

import type { Decision } from "./approval-card";

import { cancelRun, decideApproval } from "./api";
import { RunTimeline } from "./run-timeline";
import { foldTimeline, statusOf } from "./timeline";

/** A run in the chat, live: its stream, and the approve, reject and cancel actions. A sub-agent's run shows nested
 * under the delegate call that started it. */
export function RunView({ runId, nested = false }: { runId: string; nested?: boolean }) {
  const queryClient = useQueryClient();
  const { events, streaming } = useRunStream(runId);
  const onError = (error: Error) => toast.error(error.message);

  const decide = useMutation({
    mutationFn: ({ approvalId, decision }: { approvalId: string; decision: Decision }) =>
      decideApproval(approvalId, decision),
    onError,
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["approvals"] }),
  });
  const cancel = useMutation({
    mutationFn: () => cancelRun(runId),
    onError,
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["approvals"] }),
  });

  return (
    <RunTimeline
      items={foldTimeline(events)}
      status={statusOf(events)}
      streamingText={streaming}
      busy={decide.isPending || cancel.isPending}
      onDecide={(approvalId, decision) => decide.mutate({ approvalId, decision })}
      onCancel={() => cancel.mutate()}
      label={nested ? "Sub-agent" : "Agent"}
      childRunOf={({ call }) => (call.tool === DELEGATE_TOOL ? childRunId(runId, call.callId) : null)}
      renderChild={(childId) => <RunView runId={childId} nested />}
    />
  );
}
