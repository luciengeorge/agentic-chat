import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";

import { ChatSidebar } from "@/components/chat/sidebar";
import { ChunkCard } from "@/components/labs/chunk-card";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { getOptionalViewer } from "@/lib/auth.functions";

import { getChunkedPage, getLabDocuments } from "./-functions";

export const Route = createFileRoute("/labs/chunking")({
  beforeLoad: async () => {
    const viewer = await getOptionalViewer();
    if (!viewer) throw redirect({ to: "/login" });
    return { viewer };
  },
  head: () => ({ meta: [{ title: "Chunking lab · Kestrel Assistant" }] }),
  component: ChunkingLab,
});

const whole = (value: string) => (/^\d+$/.test(value) ? Number(value) : NaN);

function ChunkingLab() {
  const { viewer } = Route.useRouteContext();
  const documents = useQuery({ queryKey: ["labs", "documents"], queryFn: () => getLabDocuments() });
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [pageInput, setPageInput] = useState("1");
  const [targetInput, setTargetInput] = useState("512");
  const [overlapInput, setOverlapInput] = useState("64");

  const selected = documents.data?.find((d) => d.id === documentId) ?? documents.data?.[0];
  const pdf = selected?.mimeType === "application/pdf";
  const pages = selected?.pages ?? 1;
  const [page, target, overlap] = [whole(pageInput), whole(targetInput), whole(overlapInput)];
  const problem =
    pdf && !(page >= 1 && page <= pages)
      ? `Pick a page from 1 to ${pages}.`
      : !(target >= 16 && target <= 4096)
        ? "The target is a whole number from 16 to 4,096."
        : !(overlap >= 0 && overlap < target)
          ? "The overlap is a whole number below the target."
          : null;

  const chunked = useQuery({
    queryKey: ["labs", "chunking", selected?.id, pdf ? page : null, target, overlap],
    queryFn: () =>
      getChunkedPage({
        data: { documentId: selected!.id, page: pdf ? page : null, targetTokens: target, overlapTokens: overlap },
      }),
    enabled: selected !== undefined && problem === null,
    placeholderData: keepPreviousData,
  });
  const chunks = chunked.data?.chunks ?? [];
  const repeated = chunks.reduce((sum, c) => sum + c.overlapTokens, 0);

  return (
    <div className="flex h-svh w-full overflow-hidden">
      <ChatSidebar activeId={undefined} viewer={viewer} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight">Chunking</h1>
            <p className="text-sm text-muted-foreground">
              A page cut by <code className="font-mono">#learn/chunk/chunk</code>: your code while a chunking step is
              active, the reference otherwise. The page is chunked on its own.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-[1fr_auto_auto_auto]">
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
              <NumberField id="page" label={`Page (of ${pages})`} value={pageInput} onChange={setPageInput} />
            ) : null}
            <NumberField id="target" label="Target tokens" value={targetInput} onChange={setTargetInput} />
            <NumberField id="overlap" label="Overlap tokens" value={overlapInput} onChange={setOverlapInput} />
          </div>
          {problem ? <FieldError>{problem}</FieldError> : null}

          {documents.isError || chunked.isError ? (
            <p className="text-sm text-destructive">{(documents.error ?? chunked.error)?.message}</p>
          ) : chunked.data?.error ? (
            <div className="flex flex-col gap-1 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3">
              <p className="text-sm font-medium text-destructive">chunk() threw</p>
              <p className="font-mono text-sm">{chunked.data.error}</p>
            </div>
          ) : chunked.isPending && problem === null ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-32 w-full rounded-xl" />
              <Skeleton className="h-32 w-full rounded-xl" />
            </div>
          ) : chunks.length > 0 ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                <span className="tabular-nums">
                  {chunks.length} {chunks.length === 1 ? "chunk" : "chunks"}, {repeated} tokens repeated
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-3 rounded-sm bg-primary/20" /> overlap
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-3 rounded-sm bg-muted ring-1 ring-border" /> repeated table header
                </span>
              </div>
              <ol className="flex flex-col gap-3">
                {chunks.map((c) => (
                  <ChunkCard key={c.ordinal} chunk={c} target={target} />
                ))}
              </ol>
            </div>
          ) : chunked.data ? (
            <p className="text-sm text-muted-foreground">This page has no text.</p>
          ) : null}
        </div>
      </main>
    </div>
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
  onChange: (value: string) => void;
}) {
  return (
    <Field className="sm:w-32">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value.trim())} />
    </Field>
  );
}
