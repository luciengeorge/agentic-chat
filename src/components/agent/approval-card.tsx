import { Alert02Icon, Cancel01Icon, CheckmarkCircle02Icon, Clock01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import type { ToolCall } from "#learn/agent/types";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { approvalTitle, writeFields } from "./describe";

export type Decision = "approved" | "rejected";

const DECIDED = {
  approved: { label: "Approved", icon: CheckmarkCircle02Icon, variant: "secondary" },
  rejected: { label: "Rejected", icon: Cancel01Icon, variant: "outline" },
  expired: { label: "Expired", icon: Clock01Icon, variant: "outline" },
} as const;

/** A write waiting on its user: what it would do, any warning the guardrails raised, and the two buttons. */
export function ApprovalCard({
  call,
  expiresAt,
  decision,
  busy,
  onDecide,
  className,
}: {
  call: ToolCall;
  expiresAt: string;
  decision: "approved" | "rejected" | "expired" | null;
  busy?: boolean;
  onDecide?: (decision: Decision) => void;
  className?: string;
}) {
  const decided = decision ? DECIDED[decision] : null;
  return (
    <section
      aria-label={approvalTitle(call)}
      className={cn("flex flex-col gap-3 rounded-xl border bg-card p-4 text-sm shadow-xs", className)}
    >
      <header className="flex items-center justify-between gap-2">
        <h3 className="font-medium">{approvalTitle(call)}</h3>
        {decided ? (
          <Badge variant={decided.variant}>
            <HugeiconsIcon icon={decided.icon} strokeWidth={2} data-icon="inline-start" />
            {decided.label}
          </Badge>
        ) : (
          <Badge variant="outline">Needs your approval</Badge>
        )}
      </header>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
        {writeFields(call).map(({ label, value, long }) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className={cn("min-w-0 break-words", long && "max-h-40 overflow-y-auto whitespace-pre-wrap")}>
              {value || "None"}
            </dd>
          </div>
        ))}
      </dl>

      {call.screen?.flag ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-destructive">
          <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="mt-0.5 size-4 shrink-0" />
          {call.screen.flag}
        </p>
      ) : null}

      {decision === null && onDecide ? (
        <footer className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            Expires {new Date(expiresAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => onDecide("rejected")}>
              Reject
            </Button>
            <Button size="sm" disabled={busy} onClick={() => onDecide("approved")}>
              Approve
            </Button>
          </div>
        </footer>
      ) : null}
    </section>
  );
}
