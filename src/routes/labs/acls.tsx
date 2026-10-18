import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { z } from "zod";

import type { AclLabChunk } from "@/components/labs/acls-server";

import { ChatSidebar } from "@/components/chat/sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { getOptionalViewer } from "@/lib/auth.functions";
import { viewerMiddleware } from "@/lib/middleware";

/** The lab shows other people's access, so it refuses to run anywhere but dev. */
async function devOnly() {
  const { acEnv } = await import("@/lib/env");
  if (acEnv() !== "dev")
    throw new Error(`The ACL lab shows other people's access, so it only runs in dev (this is ${acEnv()}).`);
}

async function labDeps() {
  const { embedderFromEnv, rerankerFromEnv, rewriterFromEnv } = await import("@/lib/retrieval.server");
  const { withTenant } = await import("@/db/tenant");
  const { systemDb } = await import("@/db/pool");
  return {
    retrieve: { withTenant, embedder: embedderFromEnv(), reranker: rerankerFromEnv(), rewriter: rewriterFromEnv() },
    owner: systemDb(),
  };
}

const getUsers = createServerFn({ method: "GET" })
  .middleware([viewerMiddleware])
  .handler(async () => {
    await devOnly();
    const { aclLabUsers } = await import("@/components/labs/acls-server");
    return aclLabUsers((await labDeps()).owner);
  });

const runAs = createServerFn({ method: "POST" })
  .middleware([viewerMiddleware])
  .validator(z.object({ tenantId: z.uuid(), userId: z.uuid(), question: z.string().trim().min(1).max(500) }))
  .handler(async ({ data }) => {
    await devOnly();
    const { aclLabRun } = await import("@/components/labs/acls-server");
    return aclLabRun(await labDeps(), { tenantId: data.tenantId, userId: data.userId }, data.question);
  });

export const Route = createFileRoute("/labs/acls")({
  beforeLoad: async () => {
    const viewer = await getOptionalViewer();
    if (!viewer) throw redirect({ to: "/login" });
    return { viewer };
  },
  head: () => ({ meta: [{ title: "ACL lab · Kestrel Assistant" }] }),
  component: AclLab,
});

const pages = (chunk: AclLabChunk) =>
  chunk.pageStart === null
    ? null
    : chunk.pageEnd !== null && chunk.pageEnd !== chunk.pageStart
      ? `pp. ${chunk.pageStart}-${chunk.pageEnd}`
      : `p. ${chunk.pageStart}`;

function Chunks({ chunks, empty }: { chunks: AclLabChunk[]; empty: string }) {
  if (chunks.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ol className="flex flex-col gap-1.5">
      {chunks.map((chunk) => (
        <li key={chunk.id} className="flex flex-col gap-0.5 rounded-lg border px-3 py-2 text-sm">
          <span className="truncate font-medium">
            {chunk.path}
            {pages(chunk) ? <span className="font-normal text-muted-foreground"> · {pages(chunk)}</span> : null}
          </span>
          <span className="line-clamp-2 text-xs text-muted-foreground">{chunk.text}</span>
        </li>
      ))}
    </ol>
  );
}

function AclLab() {
  const { viewer } = Route.useRouteContext();
  const users = useQuery({ queryKey: ["labs", "acls", "users"], queryFn: () => getUsers() });
  const [picked, setPicked] = useState<string | null>(null);
  const [question, setQuestion] = useState("Project Heron acquisition of Lumen Ledger board vote");
  const user = users.data?.find((u) => u.userId === picked) ?? users.data?.find((u) => u.username === "leo.martin");
  const run = useMutation({
    mutationFn: () => runAs({ data: { tenantId: user!.tenantId, userId: user!.userId, question } }),
  });
  const result = run.data;

  return (
    <div className="flex h-svh w-full overflow-hidden">
      <ChatSidebar activeId={undefined} viewer={viewer} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight">Identity and ACLs</h1>
            <p className="text-sm text-muted-foreground">
              Search as anyone, in either tenant, and see what decided it: their groups, the chunks they got, the ones
              the decision refused, and the audit row. Dev only (it refuses in test and prod): it shows other people's
              access. Runs <code className="font-mono">#learn/retrieve/acl</code> and the rest of section 09 through
              retrieval.
            </p>
          </div>

          {users.isError ? <p className="text-sm text-destructive">{users.error.message}</p> : null}
          <form
            className="grid grid-cols-[1fr_auto] items-end gap-3 sm:grid-cols-[14rem_1fr_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              if (user) run.mutate();
            }}
          >
            <Field className="col-span-2 sm:col-span-1">
              <FieldLabel>Search as</FieldLabel>
              {users.isPending ? (
                <Skeleton className="h-9 w-full" />
              ) : (
                <Select
                  value={user?.userId ?? null}
                  onValueChange={(id) => setPicked(id as string)}
                  items={(users.data ?? []).map((u) => ({ value: u.userId, label: `${u.tenant} / ${u.username}` }))}
                >
                  <SelectTrigger className="w-full min-w-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(users.data ?? []).map((u) => (
                      <SelectItem key={u.userId} value={u.userId}>
                        {u.tenant} / {u.username}
                        {u.enabled ? "" : " (disabled)"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
            <Field>
              <FieldLabel htmlFor="question">Question</FieldLabel>
              <Input id="question" value={question} onChange={(e) => setQuestion(e.target.value)} />
            </Field>
            <Button type="submit" disabled={!user || run.isPending || question.trim() === ""}>
              Search
            </Button>
          </form>

          {run.isError ? <p className="font-mono text-sm text-destructive">{run.error.message}</p> : null}
          {run.isPending ? (
            <Skeleton className="h-48 w-full rounded-xl" />
          ) : result ? (
            <div className="flex flex-col gap-6">
              <section className="flex flex-col gap-2">
                <h2 className="text-base font-semibold">
                  {result.user.name}, {result.user.tenant}
                  {result.user.enabled ? null : (
                    <Badge variant="destructive" className="ml-2 align-middle">
                      disabled
                    </Badge>
                  )}
                </h2>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="secondary">{result.user.username}</Badge>
                  {result.groups.map((group) => (
                    <Badge key={group.name} variant="outline">
                      {group.name} <span className="text-muted-foreground">depth {group.depth}</span>
                    </Badge>
                  ))}
                </div>
                <p className="text-sm text-muted-foreground tabular-nums">
                  May read {result.documents.readable} of {result.documents.total} documents. The pre-filter searched{" "}
                  {result.documents.candidates}.
                </p>
              </section>

              <section className="flex flex-col gap-2">
                <h2 className="text-base font-semibold">Returned ({result.returned.length})</h2>
                <Chunks chunks={result.returned} empty="Nothing: the chat would abstain." />
              </section>

              <section className="flex flex-col gap-2">
                <h2 className="text-base font-semibold">Denied by readable() ({result.denied.length})</h2>
                <Chunks
                  chunks={result.denied}
                  empty="Nothing to deny: the pre-filter kept the search inside what they may read."
                />
              </section>

              <section className="flex flex-col gap-2">
                <h2 className="text-base font-semibold">The audit row</h2>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">id</dt>
                  <dd className="truncate font-mono text-xs">{result.audit.id}</dd>
                  <dt className="text-muted-foreground">returned, denied</dt>
                  <dd className="tabular-nums">
                    {result.audit.returned}, {result.audit.denied}
                  </dd>
                  <dt className="text-muted-foreground">acl_version mark</dt>
                  <dd className="tabular-nums">{result.audit.aclVersion}</dd>
                  <dt className="text-muted-foreground">query hash</dt>
                  <dd className="truncate font-mono text-xs">{result.audit.queryHash}</dd>
                </dl>
              </section>

              <section className="flex flex-col gap-2">
                <h2 className="text-base font-semibold">Across the tenant wall</h2>
                {result.walls.map((wall) => (
                  <p key={wall.tenant} className="text-sm tabular-nums">
                    {wall.tenant} has {wall.documents} documents; from {result.user.tenant}'s transaction,{" "}
                    {wall.visibleFromHere} of them can be seen.
                  </p>
                ))}
              </section>
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}
