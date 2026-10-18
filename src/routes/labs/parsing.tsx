import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { z } from "zod";

import type { ParsingLabDeps } from "@/components/labs/parsing-server";

import { ChatSidebar } from "@/components/chat/sidebar";
import { ParsedBlocks } from "@/components/labs/parsing-blocks";
import { ReviewQueue } from "@/components/labs/parsing-reviews";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { getOptionalViewer } from "@/lib/auth.functions";
import { scopeOf, viewerMiddleware } from "@/lib/middleware";

import { getLabDocuments } from "./-functions";

/** The app's own rasteriser, OCR and review threshold, as ingestion uses them. */
async function labDeps(): Promise<ParsingLabDeps> {
  const { withTenant } = await import("@/db/tenant");
  const { rasterisePage } = await import("@/lib/parse/rasterise.server");
  const { ocrPng } = await import("@/lib/parse/ocr");
  const { ocrReviewThreshold } = await import("@/workflows/ingest-deps");
  return { withTenant, parseDeps: { rasterise: rasterisePage, ocr: ocrPng }, threshold: ocrReviewThreshold() };
}
const server = () => import("@/components/labs/parsing-server");

const getParsedPage = createServerFn({ method: "GET" })
  .middleware([viewerMiddleware])
  .validator(z.object({ documentId: z.uuid(), page: z.number().int().min(1).nullable() }))
  .handler(async ({ context, data }) =>
    (await server()).parsedPage(await labDeps(), scopeOf(context.viewer), data.documentId, data.page),
  );

const queueReviews = createServerFn({ method: "POST" })
  .middleware([viewerMiddleware])
  .validator(z.object({ documentId: z.uuid() }))
  .handler(async ({ context, data }) =>
    (await server()).queueDocumentReviews(await labDeps(), scopeOf(context.viewer), data.documentId),
  );

export const Route = createFileRoute("/labs/parsing")({
  beforeLoad: async () => {
    const viewer = await getOptionalViewer();
    if (!viewer) throw redirect({ to: "/login" });
    return { viewer };
  },
  head: () => ({ meta: [{ title: "Parsing lab · Kestrel Assistant" }] }),
  component: ParsingLab,
});

function ParsingLab() {
  const { viewer } = Route.useRouteContext();
  const client = useQueryClient();
  const documents = useQuery({ queryKey: ["labs", "documents"], queryFn: () => getLabDocuments() });
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [pageInput, setPageInput] = useState("1");

  const selected = documents.data?.find((d) => d.id === documentId) ?? documents.data?.[0];
  const pdf = selected?.mimeType === "application/pdf";
  const page = /^\d+$/.test(pageInput) ? Number(pageInput) : 1;

  const parsed = useQuery({
    queryKey: ["labs", "parsing", "page", selected?.id, pdf ? page : null],
    queryFn: () => getParsedPage({ data: { documentId: selected!.id, page: pdf ? page : null } }),
    enabled: selected !== undefined,
    placeholderData: keepPreviousData,
  });
  const queue = useMutation({
    mutationFn: () => queueReviews({ data: { documentId: selected!.id } }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["labs", "parsing", "reviews"] }),
  });
  const result = parsed.data;

  return (
    <div className="flex h-svh w-full overflow-hidden">
      <ChatSidebar activeId={undefined} viewer={viewer} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight">Parsing</h1>
            <p className="text-sm text-muted-foreground">
              A page read by <code className="font-mono">#learn/parse/parse</code>: your code while a parsing step is
              active, the reference otherwise. Scanned pages go through the app's OCR, which takes a few seconds.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-[1fr_auto]">
            <Field className="col-span-2 sm:col-span-1">
              <FieldLabel>Document</FieldLabel>
              {documents.isPending ? (
                <Skeleton className="h-9 w-full" />
              ) : (
                <Select
                  value={selected?.id ?? null}
                  onValueChange={(id) => {
                    setDocumentId(id);
                    setPageInput("1");
                    queue.reset();
                  }}
                  items={(documents.data ?? []).map((d) => ({ value: d.id, label: d.title }))}
                >
                  <SelectTrigger className="w-full min-w-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(documents.data ?? []).map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
            {pdf ? (
              <Field className="sm:w-32">
                <FieldLabel htmlFor="page">{`Page (of ${result?.pages ?? selected?.pages ?? "?"})`}</FieldLabel>
                <Input
                  id="page"
                  inputMode="numeric"
                  value={pageInput}
                  onChange={(e) => setPageInput(e.target.value.trim())}
                />
              </Field>
            ) : null}
          </div>

          {documents.isError || parsed.isError ? (
            <p className="text-sm text-destructive">{(documents.error ?? parsed.error)?.message}</p>
          ) : result?.error ? (
            <div className="flex flex-col gap-1 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3">
              <p className="text-sm font-medium text-destructive">parse() threw</p>
              <p className="font-mono text-sm">{result.error}</p>
            </div>
          ) : !result ? (
            <Skeleton className="h-40 w-full rounded-xl" />
          ) : (
            <section className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {result.page ? <span className="font-medium tabular-nums">Page {result.page}</span> : null}
                {result.method ? (
                  <Badge variant={result.method === "ocr" ? "secondary" : "outline"}>
                    {result.method === "ocr" ? "OCR" : "text layer"}
                  </Badge>
                ) : (
                  <Badge variant="outline">no pages</Badge>
                )}
                {result.confidence !== null ? (
                  <span className="text-muted-foreground tabular-nums">confidence {result.confidence}</span>
                ) : null}
                {result.dueForReview ? (
                  <Badge variant="destructive">under {result.threshold}: due for review</Badge>
                ) : null}
                <span className="text-muted-foreground tabular-nums">{result.blocks.length} blocks</span>
              </div>
              <ParsedBlocks blocks={result.blocks} />
            </section>
          )}

          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-col gap-0.5">
                <h2 className="text-base font-semibold">Review queue</h2>
                <p className="text-sm text-muted-foreground">
                  OCR'd pages under the threshold, lowest confidence first. A correction cuts the page's chunks again.
                </p>
              </div>
              {pdf ? (
                <Button size="sm" variant="outline" disabled={queue.isPending} onClick={() => queue.mutate()}>
                  {queue.isPending ? "Reading every page…" : "Queue this document's pages"}
                </Button>
              ) : null}
            </div>
            {queue.data ? (
              <p className={queue.data.error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
                {queue.data.error ??
                  `${queue.data.ocrPages} OCR'd ${queue.data.ocrPages === 1 ? "page" : "pages"}, ${queue.data.queued} newly queued.`}
              </p>
            ) : null}
            {queue.error ? <p className="text-sm text-destructive">{queue.error.message}</p> : null}
            <ReviewQueue />
          </section>
        </div>
      </main>
    </div>
  );
}
