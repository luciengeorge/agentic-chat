import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import type { Decision } from "./approval-card";

import { cancelRun, decideApproval } from "./api";
import { RunTimeline } from "./run-timeline";
import { foldTimeline, statusOf } from "./timeline";
import { useRunStream } from "./use-run-stream";

/** A run in the chat, live: its stream, and the approve, reject and cancel actions. */
export function RunView({ runId }: { runId: string }) {
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
    />
  );
}
