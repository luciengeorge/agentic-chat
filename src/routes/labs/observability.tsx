import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import type { ObservabilityLab, PricedTurn } from "@/components/labs/observability-server";

import { ChatSidebar } from "@/components/chat/sidebar";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { getOptionalViewer } from "@/lib/auth.functions";
import { viewerMiddleware } from "@/lib/middleware";

/** The recorded turns priced through `#learn/observability/*`, and whether Grafana is up. */
const loadObservability = createServerFn({ method: "GET" })
  .middleware([viewerMiddleware])
  .handler(async (): Promise<ObservabilityLab> => {
    const { observabilityLab } = await import("@/components/labs/observability-server");
    return observabilityLab();
  });

export const Route = createFileRoute("/labs/observability")({
  beforeLoad: async () => {
    const viewer = await getOptionalViewer();
    if (!viewer) throw redirect({ to: "/login" });
    return { viewer };
  },
  head: () => ({ meta: [{ title: "Observability lab · Kestrel Assistant" }] }),
  component: ObservabilityLabPage,
});

const number = new Intl.NumberFormat("en-GB");
const usd = (n: number) => `$${n.toFixed(7)}`;

function ObservabilityLabPage() {
  const { viewer } = Route.useRouteContext();
  const lab = useQuery({ queryKey: ["labs", "observability"], queryFn: () => loadObservability() });
  const data = lab.data;

  return (
    <div className="flex h-svh w-full overflow-hidden">
      <ChatSidebar activeId={undefined} viewer={viewer} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-8">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight">Observability</h1>
            <p className="text-sm text-muted-foreground">
              Section 10's four recorded chat turns, priced by your <code className="font-mono">costOf</code> and added
              up by your ledger (<code className="font-mono">#learn/observability/*</code>) while a section 19 step is
              active, from the usage OpenAI reported. The traces and metrics themselves live in Grafana.
            </p>
          </div>
          {lab.isError ? (
            <p className="text-sm text-destructive">{lab.error.message}</p>
          ) : !data ? (
            <Skeleton className="h-96 w-full rounded-xl" />
          ) : (
            <>
              <GrafanaPanel data={data} />
              <CostPanel data={data} />
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function GrafanaPanel({ data }: { data: ObservabilityLab }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-medium">Grafana</h2>
        <Badge variant={data.grafana.up ? "secondary" : "outline"}>{data.grafana.up ? "running" : "not running"}</Badge>
        <Badge variant={data.exporting.enabled ? "secondary" : "outline"}>
          {data.exporting.enabled ? `this server sends to ${data.exporting.endpoint}` : "this server sends nothing"}
        </Badge>
      </div>
      {data.grafana.up ? (
        <p>
          <a href={data.grafana.url} target="_blank" rel="noreferrer" className="font-medium underline">
            Open Grafana on {data.grafana.url}
          </a>{" "}
          (admin, admin), then Explore: Tempo for traces of service <code className="font-mono">agentic-chat</code>,
          Prometheus for the metrics (step 19.2 has the queries).
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground">Start the observability stack, then send it the recorded turns:</p>
          <pre className="overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs">
            {`docker compose --profile observability up -d otel-lgtm
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 pnpm otel:sample`}
          </pre>
        </div>
      )}
      {data.exporting.enabled ? null : (
        <p className="text-muted-foreground">
          For this server's own chats, add{" "}
          <code className="font-mono">OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318</code> to{" "}
          <code className="font-mono">.env.local</code> and restart <code className="font-mono">pnpm dev</code>.
        </p>
      )}
    </section>
  );
}

function CostPanel({ data }: { data: ObservabilityLab }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-base font-medium">Cost per request</h2>
        <p className="text-sm text-muted-foreground">
          The answer as recorded, and the same turn with the one Cohere search a production key bills ($0.002). The
          rewrite and the query embedding add a few hundredths of a cent more.
        </p>
      </div>
      {data.turns.ok ? (
        <ul className="flex flex-col gap-2">
          {data.turns.value.map((turn) => (
            <TurnRow key={turn.name} turn={turn} />
          ))}
        </ul>
      ) : (
        <p className="rounded-xl border border-destructive/40 px-4 py-3 font-mono text-xs text-destructive">
          {data.turns.error}
        </p>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">The price table</summary>
        <ul className="mt-2 flex flex-col gap-1 font-mono text-xs">
          {Object.entries(data.prices).map(([model, price]) => (
            <li key={model}>
              {model}:{" "}
              {"perSearch" in price
                ? `$${price.perSearch} a search`
                : `$${price.input} input, $${price.cachedInput} cached, $${price.output} output, per million tokens`}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function TurnRow({ turn }: { turn: PricedTurn }) {
  const answer = turn.calls.find((c) => c.inputTokens !== undefined);
  const share = turn.withRerankUsd > 0 ? Math.round((1 - turn.answerUsd / turn.withRerankUsd) * 100) : 0;
  return (
    <li className="grid grid-cols-1 gap-3 rounded-xl border px-4 py-3 text-sm md:grid-cols-[1fr_14rem]">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs">{turn.name}</span>
          <span className="text-muted-foreground">{turn.user}</span>
        </div>
        <p>“{turn.question}”</p>
        {answer ? (
          <p className="text-xs text-muted-foreground tabular-nums">
            {answer.modelId}: {number.format(answer.inputTokens ?? 0)} in (
            {number.format(answer.cachedInputTokens ?? 0)} cached), {number.format(answer.outputTokens ?? 0)} out
          </p>
        ) : null}
        {turn.unpriced.length ? (
          <p className="text-xs text-destructive">Not in the price table: {turn.unpriced.join(", ")}</p>
        ) : null}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 self-start text-xs tabular-nums">
        <dt className="text-muted-foreground">Answer</dt>
        <dd>{usd(turn.answerUsd)}</dd>
        <dt className="text-muted-foreground">With a rerank</dt>
        <dd>{usd(turn.withRerankUsd)}</dd>
        <dt className="text-muted-foreground">Rerank share</dt>
        <dd>{share}%</dd>
      </dl>
    </li>
  );
}
