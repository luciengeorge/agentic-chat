import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";

import type { LoggedRequest } from "@/components/labs/boundary-log";

import { ChatSidebar } from "@/components/chat/sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getOptionalViewer } from "@/lib/auth.functions";
import { scopeOf, viewerMiddleware } from "@/lib/middleware";

/** The log holds who asked what, so the lab refuses to run anywhere but dev. */
async function devOnly() {
  const { acEnv } = await import("@/lib/env");
  if (acEnv() === "prod") throw new Error("The request log records who asked what, so it only runs in dev.");
}

const getRequestLog = createServerFn({ method: "GET" })
  .middleware([viewerMiddleware])
  .handler(async () => {
    await devOnly();
    const { recentRequests } = await import("@/components/labs/boundary-log");
    return recentRequests();
  });

/** Takes one token from the viewer's lab bucket through `#learn/boundary/rate-limit`, as the chat does from `chat`. */
const takeLabToken = createServerFn({ method: "POST" })
  .middleware([viewerMiddleware])
  .handler(async ({ context }) => {
    await devOnly();
    const { takeToken } = await import("#learn/boundary/rate-limit");
    const { LAB_BUCKET } = await import("@/components/labs/boundary-log");
    const { withTenant } = await import("@/db/tenant");
    const scope = scopeOf(context.viewer);
    return withTenant(scope.tenantId, (tx) => takeToken(tx, scope, LAB_BUCKET, new Date()));
  });

const clearRequestLog = createServerFn({ method: "POST" })
  .middleware([viewerMiddleware])
  .handler(async () => {
    await devOnly();
    const { clearRequests } = await import("@/components/labs/boundary-log");
    clearRequests();
    return null;
  });

export const Route = createFileRoute("/labs/boundary")({
  beforeLoad: async () => {
    const viewer = await getOptionalViewer();
    if (!viewer) throw redirect({ to: "/login" });
    return { viewer };
  },
  head: () => ({ meta: [{ title: "Boundary lab · Kestrel Assistant" }] }),
  component: BoundaryLab,
});

const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function BoundaryLab() {
  const { viewer } = Route.useRouteContext();
  const log = useQuery({ queryKey: ["labs", "boundary"], queryFn: () => getRequestLog(), refetchInterval: 2000 });
  const [signedOut, setSignedOut] = useState<number | null>(null);
  const take = useMutation({ mutationFn: () => takeLabToken(), onSettled: () => log.refetch() });
  const clear = useMutation({ mutationFn: () => clearRequestLog(), onSettled: () => log.refetch() });
  const anonymous = useMutation({
    // A chat route behind the middleware, asked with the cookie left off: the middleware answers before the route.
    mutationFn: () =>
      fetch(`/api/chat/documents/${crypto.randomUUID()}`, { credentials: "omit" }).then((r) => r.status),
    onSuccess: setSignedOut,
    onSettled: () => log.refetch(),
  });

  return (
    <div className="flex h-svh w-full overflow-hidden">
      <ChatSidebar activeId={undefined} viewer={viewer} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight">Request log</h1>
            <p className="text-sm text-muted-foreground">
              The last 50 requests through <code className="font-mono">viewerMiddleware</code> (your{" "}
              <code className="font-mono">#learn/boundary/middleware</code> while a section 11 step is active), newest
              first: who asked, in which tenant, what came back, and their rate-limit buckets just after. Dev only: it
              records who asked what, and keeps it in the dev server's memory.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => take.mutate()} disabled={take.isPending}>
              Take a token
            </Button>
            <Button variant="outline" onClick={() => anonymous.mutate()} disabled={anonymous.isPending}>
              Send one signed out
            </Button>
            <Button variant="ghost" onClick={() => clear.mutate()} disabled={clear.isPending}>
              Clear the log
            </Button>
            <span className="text-sm text-muted-foreground tabular-nums">
              {take.data
                ? take.data.allowed
                  ? `Allowed: ${take.data.remaining} left in the lab bucket.`
                  : `Refused: ${take.data.retryAfterSeconds} s until the next token.`
                : null}
              {take.isError ? take.error.message : null}
              {signedOut !== null ? ` Signed out: ${signedOut}.` : null}
            </span>
          </div>

          {log.isError ? (
            <p className="text-sm text-destructive">{log.error.message}</p>
          ) : !log.data ? (
            <Skeleton className="h-64 w-full rounded-xl" />
          ) : log.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">No requests yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Time</th>
                    <th className="px-3 py-2 font-medium">Route</th>
                    <th className="px-3 py-2 font-medium">Viewer</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Tokens left</th>
                  </tr>
                </thead>
                <tbody>
                  {log.data.map((entry) => (
                    <Row key={entry.id} entry={entry} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function Row({ entry }: { entry: LoggedRequest }) {
  return (
    <tr className="border-b last:border-b-0">
      <td className="px-3 py-1.5 text-muted-foreground tabular-nums">{time.format(new Date(entry.at))}</td>
      <td className="max-w-80 px-3 py-1.5">
        <span className="font-mono text-xs">{entry.method}</span> <span className="break-all">{entry.route}</span>
      </td>
      <td className="px-3 py-1.5">
        {entry.viewer ? (
          <>
            {entry.viewer} <span className="text-muted-foreground">({entry.tenant})</span>
          </>
        ) : (
          <span className="text-muted-foreground">nobody</span>
        )}
      </td>
      <td className="px-3 py-1.5 tabular-nums">
        <Badge variant={entry.status >= 400 ? "destructive" : "outline"}>{entry.status}</Badge>{" "}
        <span className="text-xs text-muted-foreground">{entry.ms} ms</span>
      </td>
      <td className="px-3 py-1.5 text-xs tabular-nums">
        {entry.buckets.length
          ? entry.buckets
              .map((b) => `${b.name} ${b.tokens.toFixed(1)}${b.capacity === null ? "" : `/${b.capacity}`}`)
              .join(", ")
          : "none"}
      </td>
    </tr>
  );
}
