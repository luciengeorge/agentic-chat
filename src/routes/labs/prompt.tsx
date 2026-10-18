import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type ReactNode, useState } from "react";
import { z } from "zod";

import type { LabSource, PromptInspection } from "@/components/labs/prompt-server";

import { ChatSidebar } from "@/components/chat/sidebar";
import { Badge } from "@/components/ui/badge";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { getOptionalViewer } from "@/lib/auth.functions";
import { viewerMiddleware } from "@/lib/middleware";

const TURNS = [
  { value: "london-hotel", label: "london-hotel: two versions of the expenses policy disagree" },
  { value: "heron", label: "heron: Leo can't read the memo, so the model abstains" },
  { value: "brightwell", label: "brightwell: the onboarding pack's hidden injection" },
  { value: "invoice-hold", label: "invoice-hold: a citation the validator drops" },
] as const;
type Name = (typeof TURNS)[number]["value"];

const K = [
  { value: "8", label: "8, what the app sends" },
  { value: "30", label: "30, everything the reranker ranked" },
] as const;

/** One recorded turn through `#learn/generate/*` and `#learn/cite/*`: the learner's code while a step is active. */
const inspect = createServerFn({ method: "GET" })
  .middleware([viewerMiddleware])
  .validator(
    z.object({
      name: z.enum(TURNS.map((t) => t.value) as [Name, ...Name[]]),
      k: z.union([z.literal(8), z.literal(30)]),
      budget: z.number().int().min(0).max(100_000),
    }),
  )
  .handler(async ({ data }): Promise<PromptInspection> => {
    const { inspectTurn } = await import("@/components/labs/prompt-server");
    return inspectTurn(data.name, data.k, data.budget);
  });

export const Route = createFileRoute("/labs/prompt")({
  beforeLoad: async () => {
    const viewer = await getOptionalViewer();
    if (!viewer) throw redirect({ to: "/login" });
    return { viewer };
  },
  head: () => ({ meta: [{ title: "Prompt lab · Kestrel Assistant" }] }),
  component: PromptLab,
});

const number = new Intl.NumberFormat("en-GB");

function PromptLab() {
  const { viewer } = Route.useRouteContext();
  const [name, setName] = useState<Name>("london-hotel");
  const [k, setK] = useState<8 | 30>(8);
  const [budgetInput, setBudgetInput] = useState("6000");
  const budget = /^\d+$/.test(budgetInput) ? Number(budgetInput) : NaN;
  const problem = budget >= 0 && budget <= 100_000 ? null : "The budget is a whole number of tokens, up to 100,000.";

  const inspection = useQuery({
    queryKey: ["labs", "prompt", name, k, budget],
    queryFn: () => inspect({ data: { name, k, budget } }),
    enabled: problem === null,
    placeholderData: keepPreviousData,
  });
  const data = inspection.data;

  return (
    <div className="flex h-svh w-full overflow-hidden">
      <ChatSidebar activeId={undefined} viewer={viewer} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight">Prompt inspector</h1>
            <p className="text-sm text-muted-foreground">
              Four chat turns recorded on 18 October 2026, replayed through{" "}
              <code className="font-mono">#learn/generate/*</code> and <code className="font-mono">#learn/cite/*</code>:
              your code while a section 10 step is active. The reply is always the recorded one, whatever prompt your
              code builds, so you see exactly what your budget and your validator make of it. Nothing here calls a
              model.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_14rem_10rem]">
            <Field>
              <FieldLabel>Recording</FieldLabel>
              <Select value={name} onValueChange={(value) => setName(value as Name)} items={[...TURNS]}>
                <SelectTrigger className="w-full min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TURNS.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel>Chunks</FieldLabel>
              <Select value={String(k)} onValueChange={(value) => setK(Number(value) as 8 | 30)} items={[...K]}>
                <SelectTrigger className="w-full min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {K.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="budget">Source budget (tokens)</FieldLabel>
              <Input
                id="budget"
                inputMode="numeric"
                value={budgetInput}
                onChange={(e) => setBudgetInput(e.target.value.trim())}
              />
            </Field>
          </div>
          {problem ? <FieldError>{problem}</FieldError> : null}

          {inspection.isError ? (
            <p className="text-sm text-destructive">{inspection.error.message}</p>
          ) : !data ? (
            <Skeleton className="h-96 w-full rounded-xl" />
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1 text-sm">
                <p className="font-medium">
                  {data.user} ({data.tenant}): “{data.question}”
                </p>
                <p className="text-muted-foreground tabular-nums">
                  {data.sources.length} of {data.k} chunks went in, {number.format(data.tokens.sources)} of{" "}
                  {number.format(data.budget)} tokens; {data.skipped.length} skipped. Instructions{" "}
                  {data.tokens.instructions} tokens.
                </p>
              </div>
              {data.error ? (
                <div className="flex flex-col gap-1 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3">
                  <p className="text-sm font-medium text-destructive">Your code threw</p>
                  <p className="font-mono text-sm">{data.error}</p>
                </div>
              ) : null}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Panel title={`Sources in (${data.sources.length})`}>
                  <SourceList sources={data.sources} empty="No source fits: the answer abstains with no model call." />
                </Panel>
                <Panel title={`Skipped by the budget (${data.skipped.length})`}>
                  <SourceList sources={data.skipped} empty="Nothing skipped: every chunk fits." />
                </Panel>
              </div>
              <Verdict data={data} />
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Panel title="Raw reply, as recorded">
                  <pre className="max-h-[28rem] overflow-auto p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
                    {data.reply}
                  </pre>
                </Panel>
                <Panel title="Assembled prompt: instructions, then the user turn">
                  <pre className="max-h-[28rem] overflow-auto p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
                    {data.instructions}
                    {"\n\n────────\n\n"}
                    {data.userTurn}
                  </pre>
                </Panel>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function Verdict({ data }: { data: PromptInspection }) {
  const verdict = data.verdict;
  if (!verdict) return null;
  return (
    <Panel title="The validator's verdict">
      <div className="flex flex-col gap-3 p-3 text-sm">
        <div className="flex flex-wrap gap-1.5">
          {verdict.abstained ? <Badge variant="secondary">abstained</Badge> : <Badge variant="outline">answered</Badge>}
          {verdict.flagged ? (
            <Badge variant="destructive">flagged</Badge>
          ) : (
            <Badge variant="outline">not flagged</Badge>
          )}
        </div>
        {verdict.kept.length ? (
          <ul className="flex flex-col gap-1">
            {verdict.kept.map((c, i) => (
              <li key={i} className="flex gap-2">
                <Badge variant="secondary">{c.label}</Badge>
                <span className="min-w-0">
                  “{c.quote}”{" "}
                  <span className="text-muted-foreground">
                    {c.title}
                    {c.page ? `, p. ${c.page}` : ""}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">No citation kept.</p>
        )}
        {verdict.dropped.length ? (
          <ul className="flex flex-col gap-1">
            {verdict.dropped.map((d, i) => (
              <li key={i} className="flex gap-2">
                <Badge variant="destructive">{d.reason}</Badge>
                <span className="min-w-0 font-mono text-xs break-all">{d.marker}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Panel>
  );
}

function SourceList({ sources, empty }: { sources: LabSource[]; empty: string }) {
  if (sources.length === 0) return <p className="p-3 text-sm text-muted-foreground">{empty}</p>;
  return (
    <ol className="flex max-h-[24rem] flex-col overflow-auto">
      {sources.map((source) => (
        <li key={source.rank} className="flex items-baseline gap-3 border-b px-3 py-1.5 text-sm last:border-b-0">
          <span className="w-10 shrink-0 font-mono text-xs text-muted-foreground tabular-nums">#{source.rank}</span>
          <span className="w-10 shrink-0 font-mono text-xs">{source.label ?? "out"}</span>
          <span className="min-w-0 flex-1 truncate">
            {source.path}
            {source.page ? <span className="text-muted-foreground"> · p. {source.page}</span> : null}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{source.tokens} tokens</span>
        </li>
      ))}
    </ol>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col overflow-hidden rounded-xl border">
      <h2 className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}
