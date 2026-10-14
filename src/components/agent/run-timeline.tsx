import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Brain02Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  File02Icon,
  Mail01Icon,
  Search01Icon,
  Share08Icon,
  StopCircleIcon,
  Task01Icon,
  UserMultipleIcon,
  UserSearch01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useState } from "react";

import type { RunStatus } from "#learn/agent/types";

import { Markdown } from "@/components/chat/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

import type { TimelineItem } from "./timeline";

import { ApprovalCard, type Decision } from "./approval-card";
import { callSummary, outcomeSummary } from "./describe";
import { FINAL } from "./timeline";

const TOOL_ICONS: Record<string, typeof Search01Icon> = {
  search_documents: Search01Icon,
  read_document: File02Icon,
  find_person: UserSearch01Icon,
  send_mail: Mail01Icon,
  share_document: Share08Icon,
  remember: Brain02Icon,
  delegate: UserMultipleIcon,
};

const STATUS: Record<RunStatus, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  queued: { label: "Queued", variant: "outline" },
  running: { label: "Working", variant: "secondary" },
  waiting: { label: "Waiting for you", variant: "outline" },
  succeeded: { label: "Done", variant: "secondary" },
  failed: { label: "Failed", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "outline" },
  timed_out: { label: "Timed out", variant: "destructive" },
};

const noCitations = () => null;

function UserBubble({ text }: { text: string }) {
  return (
    <div className="max-w-[85%] rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-[0.9375rem] leading-relaxed whitespace-pre-wrap">
      {text}
    </div>
  );
}

function Row({ icon, children, tone }: { icon: typeof Search01Icon; children: React.ReactNode; tone?: string }) {
  return (
    <li className="relative flex gap-3">
      <span
        className={cn(
          "z-10 flex size-6 shrink-0 items-center justify-center rounded-full border bg-background text-muted-foreground",
          tone,
        )}
      >
        <HugeiconsIcon icon={icon} strokeWidth={2} className="size-3.5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">{children}</div>
    </li>
  );
}

/** A sub-agent's own run, under the call that started it: collapsed until opened, so it streams only then. */
function ChildRun({ runId, renderChild }: { runId: string; renderChild: (runId: string) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="ghost"
        size="xs"
        className="self-start"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <HugeiconsIcon icon={open ? ArrowDown01Icon : ArrowRight01Icon} strokeWidth={2} data-icon="inline-start" />
        {open ? "Hide the sub-agent's steps" : "Show the sub-agent's steps"}
      </Button>
      {open ? <div className="rounded-lg border bg-muted/30 p-3">{renderChild(runId)}</div> : null}
    </div>
  );
}

function Item({
  item,
  busy,
  onDecide,
  renderChild,
}: {
  item: TimelineItem;
  busy: boolean;
  onDecide: (approvalId: string, decision: Decision) => void;
  renderChild?: (call: TimelineItem & { kind: "tool" }) => ReactNode;
}) {
  switch (item.kind) {
    case "user":
      return (
        <li className="z-10 flex justify-end">
          <UserBubble text={item.text} />
        </li>
      );
    case "plan":
      return (
        <Row icon={Task01Icon}>
          <span className="text-sm font-medium">Plan</span>
          <p className="text-sm text-muted-foreground">{item.goal}</p>
          {item.writes.length ? (
            <ul className="flex flex-wrap gap-1.5" aria-label="Planned writes">
              {item.writes.map((w, i) => (
                <li key={i}>
                  <Badge variant="outline">
                    {w.tool}
                    {w.targets.length ? `: ${w.targets.join(", ")}` : ""}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">No writes planned.</p>
          )}
        </Row>
      );
    case "text":
      return (
        <li className="prose prose-sm max-w-none pl-9 text-[0.9375rem] leading-relaxed text-foreground prose-zinc dark:prose-invert prose-p:my-2">
          <Markdown text={item.text} renderCitation={noCitations} />
        </li>
      );
    case "tool": {
      const { call, result } = item;
      const refused = result && !result.ok && result.refused;
      return (
        <Row
          icon={TOOL_ICONS[call.tool] ?? Task01Icon}
          tone={refused ? "border-destructive/40 text-destructive" : undefined}
        >
          <details className="group text-sm">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
              <span className="truncate">{callSummary(call)}</span>
              {result ? (
                <span
                  className={cn(
                    "truncate text-xs",
                    result.ok ? "text-muted-foreground" : refused ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {result.ok ? outcomeSummary(call, result) : refused ? "Refused" : "Failed"}
                </span>
              ) : (
                <Spinner className="size-3" />
              )}
            </summary>
            <div className="mt-2 flex flex-col gap-2 text-xs">
              {result && !result.ok ? <p className={cn(refused && "text-destructive")}>{result.error}</p> : null}
              <pre className="max-h-48 overflow-auto rounded-md bg-muted px-3 py-2 whitespace-pre-wrap">
                {JSON.stringify(call.input, null, 2)}
              </pre>
              {result?.ok ? (
                <pre className="max-h-48 overflow-auto rounded-md bg-muted px-3 py-2 whitespace-pre-wrap">
                  {JSON.stringify(result.output, null, 2)}
                </pre>
              ) : null}
            </div>
          </details>
          {renderChild?.(item)}
        </Row>
      );
    }
    case "approval":
      return (
        <li className="pl-9">
          <ApprovalCard
            call={item.call}
            expiresAt={item.expiresAt}
            decision={item.decision}
            busy={busy}
            onDecide={(decision) => onDecide(item.approvalId, decision)}
          />
        </li>
      );
    case "status": {
      const done = item.to === "succeeded";
      return (
        <Row
          icon={
            done
              ? CheckmarkCircle02Icon
              : item.to === "cancelled"
                ? StopCircleIcon
                : item.to === "waiting"
                  ? Task01Icon
                  : Cancel01Icon
          }
          tone={item.to === "failed" || item.to === "timed_out" ? "text-destructive" : undefined}
        >
          <span className="text-sm text-muted-foreground">
            {item.to === "waiting" ? "Waiting for your reply" : STATUS[item.to].label}
            {item.reason && !done && item.to !== "waiting" ? `: ${item.reason}` : ""}
          </span>
        </Row>
      );
    }
    case "error":
      return (
        <Row icon={Alert02Icon} tone="text-destructive">
          <span className="text-sm text-destructive">{item.message}</span>
        </Row>
      );
    case "compaction":
      return (
        <Row icon={Brain02Icon}>
          <span className="text-xs text-muted-foreground">Earlier steps summarised to save space</span>
        </Row>
      );
  }
}

/**
 * A run inline in the chat: its plan, each tool call with its input and result, approvals with their buttons,
 * status changes, and the model's text, streamed while it's written.
 */
export function RunTimeline({
  items,
  status,
  streamingText,
  busy = false,
  onDecide,
  onCancel,
  childRunOf,
  renderChild,
  label = "Agent",
}: {
  items: readonly TimelineItem[];
  status: RunStatus;
  streamingText: string;
  busy?: boolean;
  onDecide: (approvalId: string, decision: Decision) => void;
  onCancel: () => void;
  /** The sub-agent run a call started, if it's a delegate call. */
  childRunOf?: (call: TimelineItem & { kind: "tool" }) => string | null;
  /** Renders a sub-agent's run, nested under its call. */
  renderChild?: (runId: string) => ReactNode;
  label?: string;
}) {
  const live = !FINAL.has(status);
  const [first, ...rest] = items;
  const opening = first?.kind === "user" ? first : null;
  return (
    <div className="flex flex-col gap-3" aria-label="Agent run">
      {opening ? (
        <div className="flex justify-end">
          <UserBubble text={opening.text} />
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
          <Badge variant={STATUS[status].variant}>
            {status === "running" ? <Spinner data-icon="inline-start" /> : null}
            {STATUS[status].label}
          </Badge>
        </div>
        {live ? (
          <Button variant="ghost" size="xs" onClick={onCancel} disabled={busy}>
            <HugeiconsIcon icon={StopCircleIcon} strokeWidth={2} data-icon="inline-start" />
            Cancel
          </Button>
        ) : null}
      </div>

      <ol className="relative flex flex-col gap-3 before:absolute before:top-3 before:bottom-3 before:left-3 before:w-px before:bg-border">
        {(opening ? rest : items).map((item) => (
          <Item
            key={item.key}
            item={item}
            busy={busy}
            onDecide={onDecide}
            renderChild={
              childRunOf && renderChild
                ? (call) => {
                    const runId = childRunOf(call);
                    return runId ? <ChildRun runId={runId} renderChild={renderChild} /> : null;
                  }
                : undefined
            }
          />
        ))}
        {streamingText ? (
          <li className="prose prose-sm max-w-none pl-9 text-[0.9375rem] leading-relaxed text-foreground prose-zinc dark:prose-invert prose-p:my-2">
            <Markdown text={streamingText} renderCitation={noCitations} />
            <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-foreground/40 align-middle" />
          </li>
        ) : status === "running" || status === "queued" ? (
          <li className="flex items-center gap-2 pl-9 text-sm text-muted-foreground" role="status">
            <Spinner className="size-3.5" />
            Working…
          </li>
        ) : null}
      </ol>
    </div>
  );
}
