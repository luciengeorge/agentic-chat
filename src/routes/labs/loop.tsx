import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { z } from "zod";

import type { LoopLab, LoopLabStep } from "@/components/labs/loop-server";

import { ChatSidebar } from "@/components/chat/sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { getOptionalViewer } from "@/lib/auth.functions";
import { viewerMiddleware } from "@/lib/middleware";
import { cn } from "@/lib/utils";

const RUNS = [
  { value: "kpc-terms", label: "kpc-terms: Grace emails Tom KPC-2026-0142's payment terms" },
  { value: "search-timeout", label: "search-timeout: the first search times out, the model tries again" },
  { value: "brightwell", label: "brightwell: Ella asks about the onboarding pack" },
] as const;
type Name = (typeof RUNS)[number]["value"];

/** One recorded run through `#learn/agent/*`: the learner's loop while a section 13 step is active. */
const replay = createServerFn({ method: "GET" })
  .middleware([viewerMiddleware])
  .validator(
    z.object({
      name: z.enum(RUNS.map((r) => r.value) as [Name, ...Name[]]),
      tokens: z.number().int().min(0).max(1_000_000),
      modelTurns: z.number().int().min(0).max(100),
      toolCalls: z.number().int().min(0).max(500),
    }),
  )
  .handler(async ({ data }): Promise<LoopLab> => {
    const { stepThroughRun } = await import("@/components/labs/loop-server");
    const { DEFAULT_CAPS } = await import("#learn/agent/caps");
    return stepThroughRun(data.name, {
      ...DEFAULT_CAPS,
      tokens: data.tokens,
      modelTurns: data.modelTurns,
      toolCalls: data.toolCalls,
    });
  });

export const Route = createFileRoute("/labs/loop")({
  beforeLoad: async () => {
    const viewer = await getOptionalViewer();
    if (!viewer) throw redirect({ to: "/login" });
    return { viewer };
  },
  head: () => ({ meta: [{ title: "Loop lab · Kestrel Assistant" }] }),
  component: LoopLabPage,
});

const number = new Intl.NumberFormat("en-GB");
const whole = (text: string) => (/^\d+$/.test(text) ? Number(text) : NaN);

function LoopLabPage() {
  const { viewer } = Route.useRouteContext();
  const [name, setName] = useState<Name>("kpc-terms");
  const [caps, setCaps] = useState({ tokens: "60000", modelTurns: "12", toolCalls: "30" });
  const [shown, setShown] = useState(1);
  const numbers = { tokens: whole(caps.tokens), modelTurns: whole(caps.modelTurns), toolCalls: whole(caps.toolCalls) };
  const valid = Object.values(numbers).every((n) => Number.isFinite(n));

  const lab = useQuery({
    queryKey: ["labs", "loop", name, numbers],
    queryFn: () => replay({ data: { name, ...numbers } }),
    enabled: valid,
    placeholderData: keepPreviousData,
  });
  const data = lab.data;
  const steps = data?.steps ?? [];
  const visible = steps.slice(0, Math.min(shown, steps.length));

  return (
    <div className="flex h-svh w-full overflow-hidden">
      <ChatSidebar activeId={undefined} viewer={viewer} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight">Run stepper</h1>
            <p className="text-sm text-muted-foreground">
              An agent run recorded on gpt-6-luna on 19 October 2026, replayed through{" "}
              <code className="font-mono">#learn/agent/*</code>: your <code className="font-mono">decide</code>,{" "}
              <code className="font-mono">modelTurn</code>, <code className="font-mono">runTools</code> and caps while a
              section 13 step is active. The model and the tools answer from the recording, and every approval is
              granted at once. Nothing calls a model.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_8rem_8rem_8rem]">
            <Field>
              <FieldLabel>Recording</FieldLabel>
              <Select
                value={name}
                onValueChange={(value) => {
                  setName(value as Name);
                  setShown(1);
                }}
                items={[...RUNS]}
              >
                <SelectTrigger className="w-full min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RUNS.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {(
              [
                ["tokens", "Token cap"],
                ["modelTurns", "Turn cap"],
                ["toolCalls", "Tool call cap"],
              ] as const
            ).map(([key, label]) => (
              <Field key={key}>
                <FieldLabel htmlFor={key}>{label}</FieldLabel>
                <Input
                  id={key}
                  inputMode="numeric"
                  value={caps[key]}
                  onChange={(e) => setCaps((c) => ({ ...c, [key]: e.target.value.trim() }))}
                />
              </Field>
            ))}
          </div>
          {valid ? null : <FieldError>Each cap is a whole number.</FieldError>}

          {lab.isError ? (
            <p className="text-sm text-destructive">{lab.error.message}</p>
          ) : !data ? (
            <Skeleton className="h-96 w-full rounded-xl" />
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1 text-sm">
                <p className="font-medium">
                  {data.user}: “{data.message}”
                </p>
                <p className="text-muted-foreground tabular-nums">
                  {steps.length} decisions, {data.events} events ({data.recordedEvents} recorded). Showing{" "}
                  {visible.length}.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" disabled={shown <= 1} onClick={() => setShown((n) => n - 1)}>
                  Back
                </Button>
                <Button size="sm" disabled={shown >= steps.length} onClick={() => setShown((n) => n + 1)}>
                  Next step
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShown(steps.length)}>
                  Show all
                </Button>
              </div>
              <ol className="flex flex-col gap-2">
                {visible.map((step, i) => (
                  <StepRow key={i} index={i + 1} step={step} caps={data.caps} />
                ))}
              </ol>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function StepRow({ index, step, caps }: { index: number; step: LoopLabStep; caps: LoopLab["caps"] }) {
  return (
    <li className="grid grid-cols-1 gap-3 rounded-xl border px-4 py-3 text-sm md:grid-cols-[1fr_13rem]">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground tabular-nums">#{index}</span>
          <Badge variant={step.error || step.finish?.status === "failed" ? "destructive" : "secondary"}>
            {step.decision}
          </Badge>
          {step.turn?.planning ? <Badge variant="outline">planning turn</Badge> : null}
          <span className="text-xs text-muted-foreground tabular-nums">up to seq {step.seq}</span>
        </div>
        {step.error ? <p className="font-mono text-xs text-destructive">{step.error}</p> : null}
        {step.turn ? (
          <div className="flex flex-col gap-1">
            <p className="text-xs text-muted-foreground tabular-nums">
              {number.format(step.turn.inputTokens)} tokens in, {number.format(step.turn.outputTokens)} out
            </p>
            {step.turn.text ? <p className="whitespace-pre-wrap">{step.turn.text}</p> : null}
            {step.turn.calls.length ? (
              <ul className="flex flex-col gap-1">
                {step.turn.calls.map((call) => (
                  <li key={call.callId} className="min-w-0 font-mono text-xs break-all">
                    {call.tool} {call.input}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">No calls: this turn is the answer.</p>
            )}
          </div>
        ) : null}
        {step.results ? (
          <ul className="flex flex-col gap-1.5">
            {step.results.map((result) => (
              <li key={result.callId} className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-2 text-xs">
                  <Badge variant={result.ok ? "outline" : "destructive"}>{result.ok ? "ok" : "error"}</Badge>
                  <span className="font-mono">{result.tool}</span>
                </span>
                <span
                  className={cn(
                    "line-clamp-3 font-mono text-xs break-all",
                    result.ok ? "text-muted-foreground" : "text-destructive",
                  )}
                >
                  {result.text}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {step.approval ? (
          <p className="text-xs">
            <span className="font-mono">{step.approval.tool}</span> waits for the user: approved at once here.
          </p>
        ) : null}
        {step.finish ? (
          <p className="text-xs">
            Finished <span className="font-medium">{step.finish.status}</span>
            {step.finish.reason ? `: ${step.finish.reason}` : ""}
          </p>
        ) : null}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 self-start text-xs tabular-nums">
        <dt className="text-muted-foreground">Turns</dt>
        <dd>
          {step.usage.modelTurns} of {caps.modelTurns}
        </dd>
        <dt className="text-muted-foreground">Tool calls</dt>
        <dd>
          {step.usage.toolCalls} of {caps.toolCalls}
        </dd>
        <dt className="text-muted-foreground">Tokens</dt>
        <dd>
          {number.format(step.usage.tokens)} of {number.format(caps.tokens)}
        </dd>
      </dl>
    </li>
  );
}
