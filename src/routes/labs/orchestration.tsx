import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { z } from "zod";

import type { RunTree, TreeNode } from "@/components/labs/orchestration-server";

import { ChatSidebar } from "@/components/chat/sidebar";
import { Badge } from "@/components/ui/badge";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { getOptionalViewer } from "@/lib/auth.functions";
import { scopeOf, viewerMiddleware } from "@/lib/middleware";
import { cn } from "@/lib/utils";

const server = () => import("@/components/labs/orchestration-server");
const db = async () => (await import("@/db/pool")).appDb();

const RECORDED = "recorded";

/** The viewer's runs that started sub-agents. */
const getTreeRuns = createServerFn({ method: "GET" })
  .middleware([viewerMiddleware])
  .handler(async ({ context }) => (await server()).listTreeRuns(await db(), scopeOf(context.viewer)));

/** The recorded comparison through `#learn/agent/orchestrate`, or one of the viewer's own trees. */
const getTree = createServerFn({ method: "GET" })
  .middleware([viewerMiddleware])
  .validator(
    z.union([
      z.object({ source: z.literal(RECORDED), tokens: z.number().int().min(0).max(1_000_000) }),
      z.object({ source: z.literal("run"), runId: z.uuid() }),
    ]),
  )
  .handler(async ({ context, data }) => {
    const lab = await server();
    if (data.source === RECORDED) return lab.replayRecordedTree(data.tokens);
    return (await lab.runTree(await db(), scopeOf(context.viewer), data.runId)) ?? { error: "That run isn't yours." };
  });

export const Route = createFileRoute("/labs/orchestration")({
  beforeLoad: async () => {
    const viewer = await getOptionalViewer();
    if (!viewer) throw redirect({ to: "/login" });
    return { viewer };
  },
  head: () => ({ meta: [{ title: "Orchestration lab · Kestrel Assistant" }] }),
  component: OrchestrationLab,
});

const number = new Intl.NumberFormat("en-GB");
const FINAL_BAD = new Set(["failed", "cancelled", "timed_out"]);

function Spend({ node }: { node: TreeNode }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs tabular-nums">
      <dt className="text-muted-foreground">tokens</dt>
      <dd>
        {number.format(node.used.tokens)} of {number.format(node.caps.tokens)}
      </dd>
      <dt className="text-muted-foreground">tool calls</dt>
      <dd>
        {node.used.toolCalls} of {node.caps.toolCalls}
      </dd>
      <dt className="text-muted-foreground">model turns</dt>
      <dd>
        {node.used.modelTurns} of {node.caps.modelTurns}
      </dd>
    </dl>
  );
}

function Status({ node }: { node: TreeNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant={FINAL_BAD.has(node.status) ? "destructive" : "secondary"}>{node.status}</Badge>
      {node.reason ? <span className="text-xs text-destructive">{node.reason}</span> : null}
    </div>
  );
}

function Tree({ tree }: { tree: RunTree }) {
  const { parent, children } = tree;
  const uncounted = parent.counted.tokens < parent.children.tokens;
  return (
    <div className="flex flex-col gap-3">
      <section className="flex flex-col gap-3 rounded-xl border px-4 py-3 text-sm">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Parent run</span>
          <p className="font-medium">“{parent.text}”</p>
          <Status node={parent} />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium">Used, as its caps count it</span>
            <Spend node={parent} />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium">Its children spent</span>
            <p className="text-xs tabular-nums">
              {number.format(parent.children.tokens)} tokens, {parent.children.toolCalls} tool calls
            </p>
            <p className={cn("text-xs tabular-nums", uncounted ? "text-destructive" : "text-muted-foreground")}>
              counted by the parent: {number.format(parent.counted.tokens)} tokens, {parent.counted.toolCalls} calls
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium">Left of its caps</span>
            <p className="text-xs tabular-nums">
              {number.format(parent.left.tokens)} tokens, {parent.left.toolCalls} tool calls
            </p>
          </div>
        </div>
        {uncounted ? (
          <p className="text-xs text-destructive">
            The parent's log doesn't carry all its children's spend: this run is from before delegate results carried
            their child's spend, so its caps never saw what its children used.
          </p>
        ) : null}
        {parent.summary ? (
          <p className="line-clamp-4 whitespace-pre-wrap text-muted-foreground">{parent.summary}</p>
        ) : null}
      </section>
      <ol className="flex flex-col gap-2 border-l pl-4">
        {children.map((child) => (
          <li key={child.runId} className="flex flex-col gap-2 rounded-xl border px-4 py-3 text-sm">
            <div className="flex flex-col gap-1">
              <span className="font-mono text-xs text-muted-foreground">sub-agent {child.runId}</span>
              <p>{child.text}</p>
              <Status node={child} />
            </div>
            <Spend node={child} />
            {child.summary ? (
              <p className="line-clamp-3 whitespace-pre-wrap text-muted-foreground">{child.summary}</p>
            ) : null}
          </li>
        ))}
        {children.length === 0 ? <li className="text-sm text-muted-foreground">No sub-agents.</li> : null}
      </ol>
    </div>
  );
}

function OrchestrationLab() {
  const { viewer } = Route.useRouteContext();
  const [source, setSource] = useState<string>(RECORDED);
  const [tokens, setTokens] = useState("60000");
  const cap = /^\d+$/.test(tokens) ? Number(tokens) : NaN;
  const runs = useQuery({ queryKey: ["labs", "orchestration", "runs"], queryFn: () => getTreeRuns() });
  const recorded = source === RECORDED;
  const tree = useQuery({
    queryKey: ["labs", "orchestration", "tree", source, recorded ? cap : null],
    queryFn: () => getTree({ data: recorded ? { source: RECORDED, tokens: cap } : { source: "run", runId: source } }),
    enabled: !recorded || Number.isFinite(cap),
    placeholderData: keepPreviousData,
  });
  const items = [
    { value: RECORDED, label: "Recorded: Grace compares the hotel rules of policy v1 and v2" },
    ...(runs.data ?? []).map((r) => ({
      value: r.id,
      label: `${r.text || "Run"} · ${r.status} · ${r.children} sub-agents`,
    })),
  ];

  return (
    <div className="flex h-svh w-full overflow-hidden">
      <ChatSidebar activeId={undefined} viewer={viewer} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-8">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight">Agents: orchestration</h1>
            <p className="text-sm text-muted-foreground">
              A run tree: a parent run, the sub-agents its <code className="font-mono">delegate</code> calls started,
              each child's caps and spend, and what the parent has left. The recording replays through{" "}
              <code className="font-mono">#learn/agent/orchestrate</code>, your code while a section 16 step is active,
              and calls no model. Your own runs that delegated are read from the database as their runners wrote them.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_9rem]">
            <Field>
              <FieldLabel>Run tree</FieldLabel>
              <Select value={source} onValueChange={(value) => setSource(value as string)} items={items}>
                <SelectTrigger className="w-full min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {items.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {recorded ? (
              <Field>
                <FieldLabel htmlFor="tokens">Parent's token cap</FieldLabel>
                <Input
                  id="tokens"
                  inputMode="numeric"
                  value={tokens}
                  onChange={(e) => setTokens(e.target.value.trim())}
                />
              </Field>
            ) : null}
          </div>
          {recorded && !Number.isFinite(cap) ? <FieldError>The cap is a whole number of tokens.</FieldError> : null}

          {tree.isError ? (
            <p className="text-sm text-destructive">{tree.error.message}</p>
          ) : !tree.data ? (
            <Skeleton className="h-80 w-full rounded-xl" />
          ) : "error" in tree.data ? (
            <p className="font-mono text-sm text-destructive">{tree.data.error}</p>
          ) : (
            <Tree tree={tree.data.tree} />
          )}
        </div>
      </main>
    </div>
  );
}
