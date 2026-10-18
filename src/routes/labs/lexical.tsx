import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { z } from "zod";

import type { RankedChunk, Rankings } from "@/components/labs/lexical-server";

import { ChatSidebar } from "@/components/chat/sidebar";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { getOptionalViewer } from "@/lib/auth.functions";
import { scopeOf, viewerMiddleware } from "@/lib/middleware";
import { cn } from "@/lib/utils";

const getQuestions = createServerFn({ method: "GET" })
  .middleware([viewerMiddleware])
  .handler(async ({ context }) => {
    const { labQuestions } = await import("@/components/labs/lexical-server");
    return labQuestions(context.viewer.tenant.slug);
  });

/** One question searched as the viewer, by `#learn/search/*`: the learner's code while a step is active. */
const getRankings = createServerFn({ method: "GET" })
  .middleware([viewerMiddleware])
  .validator(z.object({ question: z.string().trim().min(1).max(500) }))
  .handler(async ({ context, data }): Promise<Rankings> => {
    const { acEnv } = await import("@/lib/env");
    if (acEnv() === "prod") throw new Error("The lexical lab only runs in dev.");
    const { rankings } = await import("@/components/labs/lexical-server");
    const { withTenant } = await import("@/db/tenant");
    const { embedderFromEnv } = await import("@/lib/retrieval.server");
    return rankings({ withTenant, embedder: embedderFromEnv() }, scopeOf(context.viewer), data.question);
  });

export const Route = createFileRoute("/labs/lexical")({
  beforeLoad: async () => {
    const viewer = await getOptionalViewer();
    if (!viewer) throw redirect({ to: "/login" });
    return { viewer };
  },
  head: () => ({ meta: [{ title: "Lexical lab · Kestrel Assistant" }] }),
  component: LexicalLab,
});

function LexicalLab() {
  const { viewer } = Route.useRouteContext();
  const questions = useQuery({ queryKey: ["labs", "lexical", "questions"], queryFn: () => getQuestions() });
  const [draft, setDraft] = useState("");
  const [question, setQuestion] = useState<string | null>(null);
  const asked = question ?? questions.data?.[0] ?? null;
  const ranked = useQuery({
    queryKey: ["labs", "lexical", asked],
    queryFn: () => getRankings({ data: { question: asked! } }),
    enabled: asked !== null,
    placeholderData: keepPreviousData,
  });
  const [hovered, setHovered] = useState<string | null>(null);

  return (
    <div className="flex h-svh w-full overflow-hidden">
      <ChatSidebar activeId={undefined} viewer={viewer} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight">Lexical and hybrid</h1>
            <p className="text-sm text-muted-foreground">
              One question, searched as you: BM25 through pg_search, the vectors, and the two fused with RRF, as
              retrieval does it before the reranker. Each chunk shows its place in the other lists. It runs{" "}
              <code className="font-mono">#learn/search/*</code>, your code while a step is active.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel>A recorded question</FieldLabel>
              <Select
                value={asked}
                onValueChange={(value) => setQuestion(value as string)}
                items={(questions.data ?? []).map((q) => ({ value: q, label: q }))}
              >
                <SelectTrigger className="w-full min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(questions.data ?? []).map((q) => (
                    <SelectItem key={q} value={q}>
                      {q}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (draft.trim()) setQuestion(draft.trim());
              }}
            >
              <Field className="min-w-0 flex-1">
                <FieldLabel htmlFor="question">Or your own (embedded by the app's embedder)</FieldLabel>
                <Input id="question" value={draft} onChange={(e) => setDraft(e.target.value)} />
              </Field>
              <Button type="submit" variant="outline">
                Search
              </Button>
            </form>
          </div>

          {ranked.isError ? <p className="text-sm text-destructive">{ranked.error.message}</p> : null}
          {ranked.data ? (
            <>
              <p className="text-sm text-muted-foreground">
                The question's vector came from{" "}
                {ranked.data.embedding.source === "recording" ? "the recording" : "the app's embedder"} (
                <code className="font-mono">{ranked.data.embedding.version}</code>)
                {ranked.data.vector.length === 0 ? ", and no chunk has a vector of that model" : ""}.
                {ranked.data.denied ? ` ${ranked.data.denied} listed chunks were refused by the ACL decision.` : ""}
              </p>
              <div className="grid gap-4 lg:grid-cols-3">
                <List
                  title="BM25"
                  note="pg_search, chunks_bm25_idx"
                  chunks={ranked.data.bm25}
                  own="bm25"
                  hovered={hovered}
                  onHover={setHovered}
                />
                <List
                  title="Vectors"
                  note="HNSW, cosine similarity"
                  chunks={ranked.data.vector}
                  own="vector"
                  hovered={hovered}
                  onHover={setHovered}
                />
                <List
                  title="Fused"
                  note="RRF, 1 / (60 + rank) summed"
                  chunks={ranked.data.fused}
                  own="fused"
                  hovered={hovered}
                  onHover={setHovered}
                />
              </div>
            </>
          ) : asked !== null ? (
            <div className="grid gap-4 lg:grid-cols-3">
              <Skeleton className="h-96 rounded-xl" />
              <Skeleton className="h-96 rounded-xl" />
              <Skeleton className="h-96 rounded-xl" />
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}

function List({
  title,
  note,
  chunks,
  own,
  hovered,
  onHover,
}: {
  title: string;
  note: string;
  chunks: RankedChunk[];
  own: keyof RankedChunk["ranks"];
  hovered: string | null;
  onHover: (id: string | null) => void;
}) {
  const others = (["bm25", "vector", "fused"] as const).filter((list) => list !== own);
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        <span className="truncate text-xs text-muted-foreground">{note}</span>
      </div>
      {chunks.length === 0 ? <p className="text-sm text-muted-foreground">Nothing found.</p> : null}
      <ol className="flex flex-col gap-1.5">
        {chunks.map((chunk, i) => (
          <li
            key={chunk.id}
            onMouseEnter={() => onHover(chunk.id)}
            onMouseLeave={() => onHover(null)}
            className={cn(
              "flex flex-col gap-1 rounded-lg border px-3 py-2 transition-colors",
              hovered === chunk.id && "border-primary bg-primary/5",
            )}
          >
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-xs text-muted-foreground tabular-nums">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {chunk.title}
                {chunk.page ? `, p. ${chunk.page}` : ""}
              </span>
              <span className="font-mono text-xs tabular-nums">
                {own === "fused" ? chunk.score.toFixed(5) : chunk.score.toFixed(own === "bm25" ? 2 : 4)}
              </span>
            </div>
            {chunk.section ? <p className="truncate text-xs text-muted-foreground">{chunk.section}</p> : null}
            <p className="line-clamp-2 text-xs text-muted-foreground">{chunk.snippet}</p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {others.map((list) => `${list} ${chunk.ranks[list] ?? "none"}`).join(" · ")}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
