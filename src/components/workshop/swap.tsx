import { Alert02Icon, CheckmarkCircle02Icon, PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

import type { StepRow, SwapCommand, SwapJob } from "./workshop-server";

/** A job as the page sees it: `switching` while the server answers 503 or not at all, `lost` if it forgot the job. */
export type JobView = SwapJob | { state: "switching" } | { state: "lost" };

async function fetchJob(jobId: string): Promise<JobView> {
  try {
    const response = await fetch(`/workshop/api/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
    if (response.status === 404) return { state: "lost" };
    if (!response.ok) return { state: "switching" };
    return (await response.json()) as SwapJob;
  } catch {
    return { state: "switching" };
  }
}

/**
 * Polls a step switch until it ends. `ex` pauses this very server (every request gets a 503), swaps the files and
 * restarts it (the connection drops; Vite reloads the page once it's back), so a failed poll means "still
 * switching", never an error. Once the job ends, the course is read again.
 */
export function useSwapJob(jobId: string | undefined) {
  const client = useQueryClient();
  return useQuery({
    queryKey: ["workshop-job", jobId],
    enabled: !!jobId,
    queryFn: async () => {
      const job = await fetchJob(jobId!);
      if (job.state !== "running" && job.state !== "switching") {
        await client.invalidateQueries({ queryKey: ["workshop"] });
      }
      return job;
    },
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === undefined || state === "running" || state === "switching" ? 700 : false;
    },
    retry: false,
  });
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  confirm,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  confirm: string;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{children}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button
            variant="destructive"
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            {confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const DONE_TEXT: Record<SwapCommand, (step: string) => string> = {
  start: (step) => `Started ${step}.`,
  reset: (step) => `Started ${step} over.`,
  solution: (step) => `Copied the ${step} solution into playground/.`,
};

type SwapResult = { files?: string[]; skipped?: string[]; restarted?: string[]; already_active?: boolean };

/** Where a switch stands: under way, done (with what `ex` skipped), or refused, with `--force` behind a confirm. */
export function SwapStatus({
  job,
  onDismiss,
  onForce,
}: {
  job: JobView | undefined;
  onDismiss: () => void;
  onForce: (step: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!job || job.state === "running" || job.state === "switching") {
    return (
      <Notice icon={<Spinner className="size-4" />}>
        <p className="font-medium">Switching steps…</p>
        <p className="text-muted-foreground">
          <code>ex</code> pauses the dev server, swaps the files in <code>playground/</code> and restarts it. This page
          reloads by itself when the server is back.
        </p>
      </Notice>
    );
  }
  if (job.state === "lost") {
    return (
      <Notice icon={<HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="size-4" />} onDismiss={onDismiss}>
        <p>
          This switch's result is gone: the dev server started afresh since. The step list shows where things stand.
        </p>
      </Notice>
    );
  }
  if (job.state === "done") {
    const result = (job.result ?? {}) as SwapResult;
    return (
      <Notice
        icon={<HugeiconsIcon icon={CheckmarkCircle02Icon} strokeWidth={2} className="size-4 text-primary" />}
        onDismiss={onDismiss}
      >
        <p className="font-medium">
          {result.already_active
            ? `${job.step} was already active; your work is untouched.`
            : DONE_TEXT[job.command](job.step)}
        </p>
        {result.files?.length ? (
          <p className="text-muted-foreground">
            In <code>playground/</code>: {result.files.join(", ")}
          </p>
        ) : null}
        {result.skipped?.map((reason) => (
          <p key={reason} className="text-muted-foreground">
            Skipped {reason}
          </p>
        ))}
      </Notice>
    );
  }
  return (
    <Notice
      tone="destructive"
      icon={<HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="size-4 text-destructive" />}
      onDismiss={onDismiss}
    >
      <p className="font-medium">{job.error?.error}</p>
      {typeof job.error?.detail === "string" ? <p className="text-muted-foreground">{job.error.detail}</p> : null}
      {job.wouldDiscard ? (
        <>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" variant="destructive" onClick={() => setConfirming(true)}>
              Discard my changes and start {job.step}
            </Button>
          </div>
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            title={`Discard your changes and start ${job.step}?`}
            confirm="Discard and start"
            onConfirm={() => onForce(job.step)}
          >
            Your edits in <code>playground/</code> are deleted for good. To keep them, copy them somewhere first, or
            look at them with the solution diff on their step's page.
          </ConfirmDialog>
        </>
      ) : null}
    </Notice>
  );
}

function Notice({
  icon,
  children,
  onDismiss,
  tone,
}: {
  icon: ReactNode;
  children: ReactNode;
  onDismiss?: () => void;
  tone?: "destructive";
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex gap-3 rounded-xl border px-4 py-3 text-sm",
        tone === "destructive" ? "border-destructive/30 bg-destructive/5" : "bg-muted/40",
      )}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">{children}</div>
      {onDismiss ? (
        <Button variant="ghost" size="xs" onClick={onDismiss} className="self-start">
          Dismiss
        </Button>
      ) : null}
    </div>
  );
}

/** Start the step, or, once it's active, start it over or take the solution: each a confirm away, since they discard work. */
export function StepActions({
  step,
  files,
  busy,
  onSwap,
}: {
  step: StepRow;
  files: string[];
  busy: boolean;
  onSwap: (command: SwapCommand) => void;
}) {
  const [confirm, setConfirm] = useState<"reset" | "solution" | null>(null);
  if (step.status !== "active") {
    return (
      <div className="flex flex-col gap-2">
        <Button onClick={() => onSwap("start")} disabled={busy}>
          <HugeiconsIcon icon={PlayIcon} strokeWidth={2} data-icon="inline-start" />
          Start this step
        </Button>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Copies {files.length ? files.join(", ") : "the problem files"} into <code>playground/</code> and restarts the
          dev server on them. It won't throw away unsaved work from another step without asking.
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm leading-relaxed">
        Your code is in{" "}
        {files.map((file, i) => (
          <span key={file}>
            {i ? ", " : null}
            <code className="rounded bg-muted px-1 text-[0.85em]">playground/{file}</code>
          </span>
        ))}
        . Edit it there; the app picks up each save.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => setConfirm("reset")} disabled={busy}>
          Start over
        </Button>
        <Button variant="outline" size="sm" onClick={() => setConfirm("solution")} disabled={busy}>
          Use the solution
        </Button>
      </div>
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={confirm === "reset" ? `Start ${step.id} over?` : `Put the ${step.id} solution in your playground?`}
        confirm={confirm === "reset" ? "Start over" : "Use the solution"}
        onConfirm={() => confirm && onSwap(confirm)}
      >
        {confirm === "reset"
          ? "Your edits in playground/ are replaced with the problem files, for good."
          : "Your edits in playground/ are replaced with the solution, for good. Its README explains it."}
      </ConfirmDialog>
    </div>
  );
}

export function StepLink({ id, title, direction }: { id: string; title: string; direction: "previous" | "next" }) {
  return (
    <Link
      to="/workshop/$stepId"
      params={{ stepId: id }}
      search={{}}
      className={cn(
        "flex flex-1 flex-col gap-0.5 rounded-lg border px-4 py-3 transition-colors hover:bg-muted/50",
        direction === "next" && "items-end text-right",
      )}
    >
      <span className="text-xs text-muted-foreground">{direction === "next" ? "Next" : "Previous"}</span>
      <span className="text-sm font-medium">
        {id} {title}
      </span>
    </Link>
  );
}
