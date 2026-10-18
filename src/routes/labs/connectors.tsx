import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type ReactNode, useState } from "react";
import { z } from "zod";

import type { CrawlResult, FaultSpec, Workspace } from "@/components/labs/connectors-panel";
import type { Viewer } from "@/lib/auth-server";

import { ChatSidebar } from "@/components/chat/sidebar";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getOptionalViewer } from "@/lib/auth.functions";
import { viewerMiddleware } from "@/lib/middleware";
import { cn } from "@/lib/utils";

/** The viewer's own site on fake-workspace. The lab is a dev tool: it drives the control API with the dev token. */
async function workspaceOf(viewer: Viewer): Promise<Workspace> {
  const { acEnv } = await import("@/lib/env");
  if (acEnv() === "prod") throw new Error("The connectors lab only runs in dev.");
  const { workspaceToken, workspaceUrl } = await import("@/workflows/sync-common");
  const slug = viewer.tenant.slug;
  return {
    baseUrl: workspaceUrl(),
    site: slug,
    token: workspaceToken(slug),
    controlToken: process.env.FAKE_WORKSPACE_CONTROL_TOKEN || undefined,
  };
}

const panel = () => import("@/components/labs/connectors-panel");

const crawlFn = createServerFn({ method: "POST" })
  .middleware([viewerMiddleware])
  .validator(z.object({ pageSize: z.number().int().min(1).max(200), maxRetries: z.number().int().min(0).max(10) }))
  .handler(async ({ context, data }) => (await panel()).crawl(await workspaceOf(context.viewer), data));

const FaultSchema = z.object({
  kind: z.enum(["throttle", "error", "latency"]),
  after_requests: z.number().int().min(0),
  count: z.number().int().min(1).nullable(),
  retry_after_s: z.number().int().min(0).nullable(),
  status: z.number().int().min(500).max(599),
  latency_ms: z.number().int().min(0).nullable(),
});

const addFaultFn = createServerFn({ method: "POST" })
  .middleware([viewerMiddleware])
  .validator(FaultSchema)
  .handler(async ({ context, data }) => {
    const ws = await workspaceOf(context.viewer);
    await (await panel()).addFault(ws, { ...data, path_prefix: `/v1.0/sites/${ws.site}` });
    return data;
  });

const clearFaultsFn = createServerFn({ method: "POST" })
  .middleware([viewerMiddleware])
  .handler(async ({ context }) => {
    await (await panel()).clearFaults(await workspaceOf(context.viewer));
    return null;
  });

const clockFn = createServerFn({ method: "POST" })
  .middleware([viewerMiddleware])
  .validator(z.object({ now: z.iso.datetime({ offset: true }).nullable() }))
  .handler(async ({ context, data }) => (await panel()).setClock(await workspaceOf(context.viewer), data.now));

const deliveriesFn = createServerFn({ method: "POST" })
  .middleware([viewerMiddleware])
  .validator(z.object({ flush: z.boolean() }))
  .handler(async ({ context, data }) => {
    const { deliveries, flushDeliveries } = await panel();
    const ws = await workspaceOf(context.viewer);
    return data.flush ? flushDeliveries(ws) : deliveries(ws);
  });

const renameFn = createServerFn({ method: "POST" })
  .middleware([viewerMiddleware])
  .validator(z.object({ itemId: z.string().min(1).max(100), name: z.string().min(1).max(200) }))
  .handler(async ({ context, data }) => {
    await (await panel()).renameItem(await workspaceOf(context.viewer), data.itemId, data.name);
    return null;
  });

export const Route = createFileRoute("/labs/connectors")({
  beforeLoad: async () => {
    const viewer = await getOptionalViewer();
    if (!viewer) throw redirect({ to: "/login" });
    return { viewer };
  },
  head: () => ({ meta: [{ title: "Connectors lab · Kestrel Assistant" }] }),
  component: ConnectorsLab,
});

const whole = (value: string) => (/^\d+$/.test(value) ? Number(value) : NaN);
const optional = (value: string) => (value === "" ? null : whole(value));

function ConnectorsLab() {
  const { viewer } = Route.useRouteContext();
  const [crawled, setCrawled] = useState<CrawlResult | null>(null);
  return (
    <div className="flex h-svh w-full overflow-hidden">
      <ChatSidebar activeId={undefined} viewer={viewer} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight">Connectors</h1>
            <p className="text-sm text-muted-foreground">
              fake-workspace (run <code className="font-mono">pnpm fake-workspace</code>), site{" "}
              <code className="font-mono">{viewer.tenant.slug}</code>. The crawl runs through{" "}
              <code className="font-mono">#learn/connectors/*</code>: your code while a connectors step is active.
            </p>
          </div>
          <CrawlPanel result={crawled} onResult={setCrawled} />
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <FaultsPanel />
            <div className="flex flex-col gap-6">
              <ClockPanel />
              <RenamePanel files={crawled?.files ?? []} />
            </div>
          </div>
          <DeliveriesPanel />
        </div>
      </main>
    </div>
  );
}

function Panel({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-xl border px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function NumberField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value.trim())} />
    </Field>
  );
}

function Failure({ error }: { error: Error | null }) {
  return error ? <p className="text-sm text-destructive">{error.message}</p> : null;
}

function CrawlPanel({ result, onResult }: { result: CrawlResult | null; onResult: (r: CrawlResult) => void }) {
  const [pageSize, setPageSize] = useState("5");
  const [maxRetries, setMaxRetries] = useState("5");
  const valid = whole(pageSize) >= 1 && whole(pageSize) <= 200 && whole(maxRetries) <= 10;
  const run = useMutation({
    mutationFn: () => crawlFn({ data: { pageSize: whole(pageSize), maxRetries: whole(maxRetries) } }),
    onSuccess: onResult,
  });
  return (
    <Panel title="Full crawl">
      <div className="grid grid-cols-2 items-end gap-4 sm:grid-cols-[8rem_8rem_auto]">
        <NumberField id="page-size" label="$top" value={pageSize} onChange={setPageSize} />
        <NumberField id="max-retries" label="Max retries" value={maxRetries} onChange={setMaxRetries} />
        <Button
          className="col-span-2 sm:col-span-1 sm:w-fit"
          disabled={!valid || run.isPending}
          onClick={() => run.mutate()}
        >
          {run.isPending ? "Crawling…" : "Crawl"}
        </Button>
      </div>
      {!valid ? <FieldError>$top is 1 to 200; max retries 0 to 10.</FieldError> : null}
      <Failure error={run.error} />
      {result ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm tabular-nums">
            {result.requests.length} requests, {result.files.length} files in {result.pages} pages,{" "}
            {(result.ms / 1000).toFixed(1)} s
            {result.waits.length ? `; waited ${result.waits.map((w) => `${w} ms`).join(", ")}` : ""}
          </p>
          {result.error ? (
            <p className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
              {result.error.message}
              {result.error.retryable
                ? ` (retryable${result.error.retryAfterMs !== null ? `, after ${result.error.retryAfterMs} ms` : ""})`
                : ""}
            </p>
          ) : null}
          <ol className="max-h-72 overflow-auto rounded-lg border font-mono text-xs">
            {result.requests.map((r) => (
              <li key={r.n} className="flex gap-3 border-b px-3 py-1 last:border-b-0">
                <span className="w-6 shrink-0 text-right text-muted-foreground tabular-nums">{r.n}</span>
                <span className={cn("w-8 shrink-0 tabular-nums", r.status !== 200 && "text-destructive")}>
                  {r.status ?? "—"}
                </span>
                <span className="w-24 shrink-0 text-muted-foreground">
                  {r.retryAfter ? `retry ${r.retryAfter}s` : ""}
                </span>
                <span className="min-w-0 truncate">{decodeURIComponent(r.path)}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </Panel>
  );
}

const KINDS = [
  { value: "throttle", label: "throttle (429)" },
  { value: "error", label: "error (5xx)" },
  { value: "latency", label: "latency" },
] as const;

function FaultsPanel() {
  const [kind, setKind] = useState<FaultSpec["kind"]>("throttle");
  const [after, setAfter] = useState("6");
  const [count, setCount] = useState("2");
  const [retryAfter, setRetryAfter] = useState("3");
  const [status, setStatus] = useState("503");
  const [latency, setLatency] = useState("500");
  const [added, setAdded] = useState<z.infer<typeof FaultSchema>[]>([]);
  const spec = {
    kind,
    after_requests: whole(after),
    count: optional(count),
    retry_after_s: optional(retryAfter),
    status: whole(status),
    latency_ms: kind === "latency" ? whole(latency) : null,
  };
  const valid = FaultSchema.safeParse(spec).success;
  const add = useMutation({
    mutationFn: () => addFaultFn({ data: spec }),
    onSuccess: (f) => setAdded((a) => [...a, f]),
  });
  const clear = useMutation({ mutationFn: () => clearFaultsFn(), onSuccess: () => setAdded([]) });
  return (
    <Panel
      title="Faults"
      action={
        <Button variant="outline" size="sm" onClick={() => clear.mutate()} disabled={clear.isPending}>
          Clear all
        </Button>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field className="col-span-2">
          <FieldLabel>Kind</FieldLabel>
          <Select value={kind} onValueChange={(v) => setKind(v as FaultSpec["kind"])} items={[...KINDS]}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KINDS.map((k) => (
                <SelectItem key={k.value} value={k.value}>
                  {k.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <NumberField id="after" label="After requests" value={after} onChange={setAfter} />
        <NumberField id="count" label="Times (blank: until cleared)" value={count} onChange={setCount} />
        <NumberField
          id="retry-after"
          label="Retry-After, s (blank: none)"
          value={retryAfter}
          onChange={setRetryAfter}
        />
        {kind === "error" ? <NumberField id="status" label="Status" value={status} onChange={setStatus} /> : null}
        {kind === "latency" ? (
          <NumberField id="latency" label="Latency, ms" value={latency} onChange={setLatency} />
        ) : null}
      </div>
      <Button className="w-fit" disabled={!valid || add.isPending} onClick={() => add.mutate()}>
        Add fault
      </Button>
      <Failure error={add.error ?? clear.error} />
      {added.length ? (
        <ul className="flex flex-col gap-1 font-mono text-xs">
          {added.map((f, i) => (
            <li key={i}>
              {f.kind} after {f.after_requests}, {f.count ?? "∞"}×{f.kind === "error" ? ` ${f.status}` : ""}
              {f.retry_after_s !== null ? `, Retry-After ${f.retry_after_s}` : ""}
              {f.latency_ms !== null ? `, ${f.latency_ms} ms` : ""}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          Faults added here hold until you clear them or fake-workspace restarts.
        </p>
      )}
    </Panel>
  );
}

function ClockPanel() {
  const [now, setNow] = useState("2026-10-18T09:00:00Z");
  const pin = useMutation({ mutationFn: (value: string | null) => clockFn({ data: { now: value } }) });
  const valid = z.iso.datetime({ offset: true }).safeParse(now).success;
  return (
    <Panel title="Clock">
      <div className="flex items-end gap-2">
        <Field className="min-w-0 flex-1">
          <FieldLabel htmlFor="clock">Pin to</FieldLabel>
          <Input id="clock" value={now} onChange={(e) => setNow(e.target.value.trim())} />
        </Field>
        <Button disabled={!valid || pin.isPending} onClick={() => pin.mutate(now)}>
          Pin
        </Button>
        <Button variant="outline" disabled={pin.isPending} onClick={() => pin.mutate(null)}>
          Unpin
        </Button>
      </div>
      <Failure error={pin.error} />
      {pin.data ? (
        <p className="text-sm text-muted-foreground tabular-nums">
          fake-workspace says it's {pin.data.now} ({pin.data.pinned ? "pinned" : "real time"}).
        </p>
      ) : null}
    </Panel>
  );
}

function RenamePanel({ files }: { files: CrawlResult["files"] }) {
  const queryClient = useQueryClient();
  const [itemId, setItemId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const selected = files.find((f) => f.id === itemId) ?? files[0];
  const rename = useMutation({
    mutationFn: () => renameFn({ data: { itemId: selected!.id, name } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["labs", "deliveries"] }),
  });
  return (
    <Panel title="Rename a file">
      {files.length === 0 ? (
        <p className="text-sm text-muted-foreground">Crawl first, then pick a file.</p>
      ) : (
        <div className="flex flex-col gap-2">
          <Select
            value={selected?.id ?? null}
            onValueChange={setItemId}
            items={files.map((f) => ({ value: f.id, label: f.path }))}
          >
            <SelectTrigger className="w-full min-w-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {files.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.path}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-end gap-2">
            <Field className="min-w-0 flex-1">
              <FieldLabel htmlFor="new-name">New name</FieldLabel>
              <Input id="new-name" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Button disabled={!name.trim() || rename.isPending} onClick={() => rename.mutate()}>
              Rename
            </Button>
          </div>
          <Failure error={rename.error} />
          {rename.isSuccess ? <p className="text-sm text-muted-foreground">Renamed. A delta will see it.</p> : null}
        </div>
      )}
    </Panel>
  );
}

function DeliveriesPanel() {
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ["labs", "deliveries"], queryFn: () => deliveriesFn({ data: { flush: false } }) });
  const flush = useMutation({
    mutationFn: () => deliveriesFn({ data: { flush: true } }),
    onSuccess: (value) => queryClient.setQueryData(["labs", "deliveries"], value),
  });
  return (
    <Panel
      title="Webhook deliveries"
      action={
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => list.refetch()}>
            Refresh
          </Button>
          <Button variant="outline" size="sm" disabled={flush.isPending} onClick={() => flush.mutate()}>
            Flush
          </Button>
        </div>
      }
    >
      <Failure error={list.error ?? flush.error} />
      {list.data?.length ? (
        <ol className="flex flex-col gap-1 font-mono text-xs">
          {list.data.map((d) => (
            <li key={d.id} className="flex flex-wrap gap-x-3">
              <span>change {d.change_seq}</span>
              <span className={cn(d.state === "failed" && "text-destructive")}>{d.state}</span>
              <span className="text-muted-foreground">
                {d.attempts.map((a) => a.status ?? a.error ?? "no answer").join(" → ") || "no attempt yet"}
              </span>
            </li>
          ))}
        </ol>
      ) : list.data ? (
        <p className="text-sm text-muted-foreground">
          None yet. A delivery appears when a subscribed drive changes;{" "}
          <code className="font-mono">pnpm sync full</code> subscribes the app.
        </p>
      ) : null}
    </Panel>
  );
}
