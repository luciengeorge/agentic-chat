import { useMutation } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { z } from "zod";

import type { VectorLabRun, VectorSource } from "@/components/labs/vectors-server";

import { ChatSidebar } from "@/components/chat/sidebar";
import { RecallLatencyChart } from "@/components/labs/vectors-chart";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { getOptionalViewer } from "@/lib/auth.functions";
import { viewerMiddleware } from "@/lib/middleware";

const SOURCES: { value: VectorSource; label: string }[] = [
  { value: "corpus", label: "Dev corpus (every embedded chunk, filing included)" },
  { value: "recording", label: "The recording (434 chunks, what the tests use)" },
];

/** Every variant, measured through `#learn/vectors/*`: the learner's code while a section 06 step is active. */
const runVectors = createServerFn({ method: "POST" })
  .middleware([viewerMiddleware])
  .validator(z.object({ source: z.enum(["corpus", "recording"]) }))
  .handler(async ({ data }): Promise<VectorLabRun> => {
    const { acEnv } = await import("@/lib/env");
    if (acEnv() !== "dev") throw new Error("The vectors lab only runs in dev.");
    const adminUrl = process.env.DATABASE_ADMIN_URL;
    if (!adminUrl) throw new Error("DATABASE_ADMIN_URL must be set (.env.local).");
    const { runVectorLab } = await import("@/components/labs/vectors-server");
    return runVectorLab(adminUrl, data.source);
  });

export const Route = createFileRoute("/labs/vectors")({
  beforeLoad: async () => {
    const viewer = await getOptionalViewer();
    if (!viewer) throw redirect({ to: "/login" });
    return { viewer };
  },
  head: () => ({ meta: [{ title: "Vectors lab · Kestrel Assistant" }] }),
  component: VectorsLab,
});

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function VectorsLab() {
  const { viewer } = Route.useRouteContext();
  const [source, setSource] = useState<VectorSource>("corpus");
  const run = useMutation({ mutationFn: (from: VectorSource) => runVectors({ data: { source: from } }) });
  const result = run.data;

  return (
    <div className="flex h-svh w-full overflow-hidden">
      <ChatSidebar activeId={undefined} viewer={viewer} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight">Vectors</h1>
            <p className="text-sm text-muted-foreground">
              Every way section 06 stores and searches vectors, measured on the 46 golden questions: recall@10 against
              an exact scan, and the median time of one search. It runs{" "}
              <code className="font-mono">#learn/vectors/*</code> (your code while a step is active) on a copy of the
              vectors in a scratch database, <code className="font-mono">ac_vectors_lab</code>.
            </p>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <Field className="min-w-0 flex-1">
              <FieldLabel>Vectors</FieldLabel>
              <Select value={source} onValueChange={(value) => setSource(value as VectorSource)} items={SOURCES}>
                <SelectTrigger className="w-full min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SOURCES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Button disabled={run.isPending} onClick={() => run.mutate(source)}>
              {run.isPending ? <Spinner data-icon="inline-start" /> : null}
              {run.isPending ? "Measuring" : "Run"}
            </Button>
          </div>
          {run.isPending ? (
            <p className="text-sm text-muted-foreground">
              Copying the vectors, building six HNSW indexes and timing about 1,100 searches: about ten seconds on the
              dev corpus.
            </p>
          ) : null}
          {run.isError ? <p className="text-sm text-destructive">{run.error.message}</p> : null}

          {result ? (
            <section className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground tabular-nums">
                {result.rows.toLocaleString()} distinct vectors, {result.queries} questions.
              </p>
              {result.error ? (
                <div className="flex flex-col gap-1 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3">
                  <p className="text-sm font-medium text-destructive">The run stopped</p>
                  <p className="font-mono text-sm">{result.error}</p>
                </div>
              ) : null}
              {result.variants.length > 1 ? <RecallLatencyChart variants={result.variants} /> : null}
              {result.variants.length > 0 ? (
                <table className="w-full text-sm tabular-nums">
                  <thead className="text-left text-muted-foreground">
                    <tr className="border-b">
                      <th className="py-1.5 font-medium">Variant</th>
                      <th className="py-1.5 text-right font-medium">Bytes a vector</th>
                      <th className="py-1.5 text-right font-medium">Index</th>
                      <th className="py-1.5 text-right font-medium">Recall@10</th>
                      <th className="py-1.5 text-right font-medium">Median</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.variants.map((v) => (
                      <tr key={v.name} className="border-b last:border-0">
                        <td className="py-1.5">{v.name}</td>
                        <td className="py-1.5 text-right">{v.bytesPerVector.toLocaleString()}</td>
                        <td className="py-1.5 text-right">{v.indexBytes === null ? "" : mb(v.indexBytes)}</td>
                        <td className="py-1.5 text-right">{pct(v.recall)}</td>
                        <td className="py-1.5 text-right">{v.medianMs.toFixed(2)} ms</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </section>
          ) : null}
        </div>
      </main>
    </div>
  );
}
