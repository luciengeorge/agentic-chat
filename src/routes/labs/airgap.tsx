import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { z } from "zod";

import type { ModelRow, ProbeName, ProbeResult } from "@/components/labs/airgap-server";

import { ChatSidebar } from "@/components/chat/sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/workshop/swap";
import { getOptionalViewer } from "@/lib/auth.functions";
import { viewerMiddleware } from "@/lib/middleware";
import { cn } from "@/lib/utils";

const server = () => import("@/components/labs/airgap-server");

/** The monitor changes this whole server process, for every request: dev only. */
async function devOnly() {
  const { acEnv } = await import("@/lib/env");
  if (acEnv() !== "dev")
    throw new Error(`The air-gapped lab changes the server process, so it only runs in dev (this is ${acEnv()}).`);
}

const getAirgap = createServerFn({ method: "GET" })
  .middleware([viewerMiddleware])
  .handler(async () => {
    await devOnly();
    const { latestEgressReport, modelRows, monitorStatus } = await server();
    const { modelProvider } = await import("#learn/local/config");
    const { embedderFromEnv, rerankerFromEnv } = await import("@/lib/retrieval.server");
    const { chatModelFromEnv } = await import("@/routes/api/chat/-deps");
    const names = {
      chat: chatModelFromEnv().id,
      embeddings: embedderFromEnv(process.env, { purpose: "query" }).version,
      reranker: rerankerFromEnv().name,
    };
    return {
      provider: modelProvider(),
      rows: modelRows(process.env, names),
      monitor: monitorStatus(),
      report: latestEgressReport(),
    };
  });

const setMonitor = createServerFn({ method: "POST" })
  .middleware([viewerMiddleware])
  .validator(z.object({ on: z.boolean() }))
  .handler(async ({ data }) => {
    await devOnly();
    const { startMonitor, stopMonitor } = await server();
    return data.on ? startMonitor() : stopMonitor();
  });

const PROBE_NAMES = ["openai", "cohere", "huggingface", "lmstudio", "database"] as const satisfies ProbeName[];
const PROBE_LABELS: Record<ProbeName, string> = {
  openai: "OpenAI",
  cohere: "Cohere",
  huggingface: "Hugging Face",
  lmstudio: "LM Studio",
  database: "ParadeDB",
};

const runProbe = createServerFn({ method: "POST" })
  .middleware([viewerMiddleware])
  .validator(z.object({ name: z.enum(PROBE_NAMES) }))
  .handler(async ({ data }) => {
    await devOnly();
    const { probe, probeTarget } = await server();
    const { host, port } = probeTarget(data.name, process.env);
    return probe(host, port);
  });

export const Route = createFileRoute("/labs/airgap")({
  beforeLoad: async () => {
    const viewer = await getOptionalViewer();
    if (!viewer) throw redirect({ to: "/login" });
    return { viewer };
  },
  head: () => ({ meta: [{ title: "Air-gapped lab · Kestrel Assistant" }] }),
  component: AirgapLab,
});

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function Models({ rows }: { rows: ModelRow[] }) {
  return (
    <ul className="flex flex-col divide-y rounded-xl border">
      {rows.map((row) => (
        <li key={row.part} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
          <span className="w-24 shrink-0 font-medium">{row.part}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{row.model}</span>
          <span className="text-muted-foreground">{row.where}</span>
          <Badge variant={row.local ? "secondary" : "outline"} className={cn(row.local ? "text-primary" : null)}>
            {row.local ? "on this machine" : "leaves the machine"}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

function ProbeLine({ result }: { result: ProbeResult }) {
  return (
    <p className="font-mono text-xs">
      <span
        className={cn(
          result.outcome === "refused" ? "text-primary" : result.outcome === "failed" ? "text-destructive" : null,
        )}
      >
        {result.target} {result.outcome}
      </span>{" "}
      <span className="text-muted-foreground">
        in {result.ms} ms: {result.detail}
      </span>
    </p>
  );
}

function AirgapLab() {
  const { viewer } = Route.useRouteContext();
  const client = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [probes, setProbes] = useState<ProbeResult[]>([]);
  const lab = useQuery({
    queryKey: ["labs", "airgap"],
    queryFn: () => getAirgap(),
    refetchInterval: (query) => (query.state.data?.monitor.on ? 2_000 : false),
  });
  const toggle = useMutation({
    mutationFn: (on: boolean) => setMonitor({ data: { on } }),
    onSettled: () => client.invalidateQueries({ queryKey: ["labs", "airgap"] }),
  });
  const tryProbe = useMutation({
    mutationFn: (name: ProbeName) => runProbe({ data: { name } }),
    onSuccess: (result) => {
      setProbes((previous) => [result, ...previous].slice(0, 8));
      void client.invalidateQueries({ queryKey: ["labs", "airgap"] });
    },
  });
  const data = lab.data;
  const monitor = data?.monitor;

  return (
    <div className="flex h-svh w-full overflow-hidden">
      <ChatSidebar activeId={undefined} viewer={viewer} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-8">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight">Air-gapped</h1>
            <p className="text-sm text-muted-foreground">
              Where each model runs, and an egress monitor inside this dev server: every connection it lets through, and
              every one it refuses. It runs <code className="font-mono">#learn/local/egress</code>, your code while step
              21.2 is active. Dev only.
            </p>
          </div>

          {lab.isError ? <p className="font-mono text-sm text-destructive">{lab.error.message}</p> : null}
          {lab.isPending ? <Skeleton className="h-40 w-full rounded-xl" /> : null}
          {!data ? null : (
            <>
              <section className="flex flex-col gap-3">
                <h2 className="text-sm font-medium">
                  The models <span className="font-normal text-muted-foreground">(MODEL_PROVIDER={data.provider})</span>
                </h2>
                <Models rows={data.rows} />
              </section>

              <section className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-sm font-medium">
                    The egress monitor{" "}
                    <span className="font-normal text-muted-foreground">
                      {monitor?.on ? `on since ${time(monitor.since!)}` : "off"}
                    </span>
                  </h2>
                  {monitor?.on ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={toggle.isPending}
                      onClick={() => toggle.mutate(false)}
                    >
                      Turn it off
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      disabled={toggle.isPending}
                      onClick={() => (data.provider === "hosted" ? setConfirming(true) : toggle.mutate(true))}
                    >
                      Turn it on
                    </Button>
                  )}
                </div>
                {toggle.isError ? <p className="font-mono text-sm text-destructive">{toggle.error.message}</p> : null}
                {monitor?.on ? (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="flex flex-col gap-1.5">
                      <h3 className="text-xs text-muted-foreground">Let through (this machine)</h3>
                      {monitor.allowed.length ? (
                        <ul className="flex flex-col gap-0.5 font-mono text-xs">
                          {monitor.allowed.map((entry) => (
                            <li key={entry.target}>
                              {entry.target} <span className="text-muted-foreground">×{entry.count}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-xs text-muted-foreground">Nothing yet. Ask the chat something.</p>
                      )}
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <h3 className="text-xs text-muted-foreground">Refused ({monitor.refusedTotal})</h3>
                      {monitor.refused.length ? (
                        <ul className="flex flex-col gap-0.5 font-mono text-xs">
                          {monitor.refused.map((attempt, i) => (
                            <li key={`${attempt.at}-${i}`}>
                              {attempt.host}:{attempt.port}{" "}
                              <span className="text-muted-foreground">{time(attempt.at)}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-xs text-muted-foreground">Nothing has tried to leave.</p>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Off, every connection goes wherever it's sent. On, anything that isn't this machine fails before its
                    DNS lookup, and is listed here.
                  </p>
                )}
                <div className="flex flex-col gap-2 rounded-xl border bg-muted/30 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted-foreground">Try to reach</span>
                    {PROBE_NAMES.map((name) => (
                      <Button
                        key={name}
                        variant="outline"
                        size="xs"
                        disabled={tryProbe.isPending}
                        onClick={() => tryProbe.mutate(name)}
                      >
                        {PROBE_LABELS[name]}
                      </Button>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Each opens a TCP connection and closes it at once; nothing is sent.
                  </p>
                  {tryProbe.isError ? (
                    <p className="font-mono text-xs text-destructive">{tryProbe.error.message}</p>
                  ) : null}
                  {probes.map((result, i) => (
                    <ProbeLine key={`${result.target}-${i}`} result={result} />
                  ))}
                </div>
              </section>

              {data.report ? (
                <section className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">
                    The last <code className="font-mono">pnpm local:egress-check</code>{" "}
                    <span className="font-normal text-muted-foreground">
                      {data.report.date}, {data.report.passed ? "passed" : "failed"}
                    </span>
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    From inside the <code className="font-mono">airgap</code> Compose network, which has no route out:
                  </p>
                  <ul className="flex flex-col gap-0.5 font-mono text-xs">
                    {data.report.network.map((row) => (
                      <li key={`${row.probe}-${row.target}`}>
                        <span className={row.reached ? "text-primary" : undefined}>
                          {row.probe} {row.target} {row.reached ? "reached" : "refused"}
                        </span>{" "}
                        <span className="text-muted-foreground">
                          in {row.ms} ms ({row.detail})
                        </span>
                      </li>
                    ))}
                  </ul>
                  <ul className="flex flex-col gap-1 text-sm">
                    {data.report.checks
                      .filter((check) => !check.name.startsWith("network:"))
                      .map((check) => (
                        <li key={check.name} className="flex gap-2">
                          <span className={check.passed ? "text-primary" : "text-destructive"}>
                            {check.passed ? "✓" : "✗"}
                          </span>
                          <span>
                            {check.name}: <span className="text-muted-foreground">{check.detail}</span>
                          </span>
                        </li>
                      ))}
                  </ul>
                </section>
              ) : null}
            </>
          )}
        </div>
      </main>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Turn the monitor on with hosted models?"
        confirm="Turn it on"
        onConfirm={() => toggle.mutate(true)}
      >
        MODEL_PROVIDER is hosted, so every chat, embedding and rerank call goes to OpenAI or Cohere. With the monitor
        on, each is refused, and the retries stretch each refusal out: 6 s for OpenAI, a minute for Cohere. Turn it off
        here, or restart the dev server, to undo it.
      </ConfirmDialog>
    </div>
  );
}
