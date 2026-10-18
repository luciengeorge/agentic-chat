import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type ReactNode, useState } from "react";
import { z } from "zod";

import type { Inspection, LabChatEvent, LabSseEvent } from "@/components/labs/models-inspect";

import { ChatSidebar } from "@/components/chat/sidebar";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { getOptionalViewer } from "@/lib/auth.functions";
import { viewerMiddleware } from "@/lib/middleware";

const CASSETTES = [
  { value: "answer", label: "answer: the chat prompt, streamed" },
  { value: "tool-call-1", label: "tool-call-1: the model calls search_documents" },
  { value: "tool-call-2", label: "tool-call-2: the result goes back" },
  { value: "rewrite", label: "rewrite: structured output, through the AI SDK" },
] as const;
type Name = (typeof CASSETTES)[number]["value"];

/** One recording, read by `#learn/model/*`: the learner's code while a model step is active. */
const inspect = createServerFn({ method: "GET" })
  .middleware([viewerMiddleware])
  .validator(
    z.object({
      name: z.enum(CASSETTES.map((c) => c.value) as [Name, ...Name[]]),
      readSize: z.number().int().min(1).max(100_000),
    }),
  )
  .handler(async ({ data }): Promise<Inspection> => {
    const { inspectCassette } = await import("@/components/labs/models-inspect");
    return inspectCassette(data.name, data.readSize);
  });

export const Route = createFileRoute("/labs/models")({
  beforeLoad: async () => {
    const viewer = await getOptionalViewer();
    if (!viewer) throw redirect({ to: "/login" });
    return { viewer };
  },
  head: () => ({ meta: [{ title: "Models lab · Kestrel Assistant" }] }),
  component: ModelsLab,
});

const number = new Intl.NumberFormat("en-GB");

function ModelsLab() {
  const { viewer } = Route.useRouteContext();
  const [name, setName] = useState<Name>("answer");
  const [readSizeInput, setReadSizeInput] = useState("1024");
  const readSize = /^\d+$/.test(readSizeInput) ? Number(readSizeInput) : NaN;
  const problem = readSize >= 1 && readSize <= 100_000 ? null : "The read size is a whole number from 1 to 100,000.";

  const inspection = useQuery({
    queryKey: ["labs", "models", name, readSize],
    queryFn: () => inspect({ data: { name, readSize } }),
    enabled: problem === null,
    placeholderData: keepPreviousData,
  });
  const data = inspection.data;

  return (
    <div className="flex h-svh w-full overflow-hidden">
      <ChatSidebar activeId={undefined} viewer={viewer} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight">Models</h1>
            <p className="text-sm text-muted-foreground">
              Four calls to gpt-6-luna, recorded on 18 October 2026 and replayed through{" "}
              <code className="font-mono">#learn/model/*</code>: your code while a model step is active, the reference
              otherwise. Nothing here calls OpenAI.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto]">
            <Field>
              <FieldLabel>Recording</FieldLabel>
              <Select value={name} onValueChange={(value) => setName(value as Name)} items={[...CASSETTES]}>
                <SelectTrigger className="w-full min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CASSETTES.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field className="sm:w-40">
              <FieldLabel htmlFor="read-size">Read size (bytes)</FieldLabel>
              <Input
                id="read-size"
                inputMode="numeric"
                value={readSizeInput}
                onChange={(e) => setReadSizeInput(e.target.value.trim())}
              />
            </Field>
          </div>
          {problem ? <FieldError>{problem}</FieldError> : null}

          {inspection.isError ? (
            <p className="text-sm text-destructive">{inspection.error.message}</p>
          ) : !data ? (
            <Skeleton className="h-96 w-full rounded-xl" />
          ) : (
            <div className="flex flex-col gap-4">
              <Summary data={data} />
              {data.error ? (
                <div className="flex flex-col gap-1 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3">
                  <p className="text-sm font-medium text-destructive">Your code threw</p>
                  <p className="font-mono text-sm">{data.error}</p>
                </div>
              ) : null}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Panel title="Request body">
                  <pre className="max-h-[36rem] overflow-auto p-3 font-mono text-xs leading-relaxed">
                    {data.request}
                  </pre>
                </Panel>
                {data.events ? (
                  <Panel title={`Events (${data.events.length})`}>
                    <ol className="flex max-h-[36rem] flex-col overflow-auto">
                      {data.events.map((event) => (
                        <EventRow key={event.index} event={event} />
                      ))}
                    </ol>
                  </Panel>
                ) : (
                  <Panel title="Response body">
                    <pre className="max-h-[36rem] overflow-auto p-3 font-mono text-xs leading-relaxed">
                      {data.response}
                    </pre>
                  </Panel>
                )}
              </div>
              {data.chatEvents ? <ChatEvents events={data.chatEvents} /> : null}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function Summary({ data }: { data: Inspection }) {
  const counted = data.counted;
  return (
    <div className="flex flex-col gap-1 text-sm">
      <p className="font-medium">{data.title}</p>
      <p className="text-muted-foreground tabular-nums">
        {number.format(data.bytes)} bytes of {data.contentType}
        {data.events ? `, in ${number.format(data.reads)} reads, ${data.events.length} events` : ""}
      </p>
      <p className="text-muted-foreground tabular-nums">
        {counted
          ? `Counted before sending: ${counted.total} (instructions ${counted.instructions}, messages ${counted.messages}, tools ${counted.tools})${counted.schema ? `, plus a ${counted.schema}-token schema` : ""}. `
          : ""}
        {data.billed
          ? `Billed: ${data.billed.input} in, ${data.billed.output} out (${data.billed.reasoning} reasoning).`
          : ""}
      </p>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col overflow-hidden rounded-xl border">
      <h2 className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

/** What an event says, in a few words: its delta, its item or its bill. */
function gist(event: LabSseEvent): string {
  try {
    const data = JSON.parse(event.data) as {
      delta?: string;
      arguments?: string;
      item?: { type?: string; name?: string; call_id?: string };
      response?: { usage?: { input_tokens?: number; output_tokens?: number } };
    };
    if (data.delta !== undefined) return JSON.stringify(data.delta);
    if (data.arguments !== undefined) return data.arguments;
    if (data.item?.type === "function_call") return `${data.item.name} ${data.item.call_id}`;
    if (data.item?.type) return data.item.type;
    if (data.response?.usage) return `${data.response.usage.input_tokens} in, ${data.response.usage.output_tokens} out`;
  } catch {
    // Not JSON: the raw data is the gist.
  }
  return event.data.length > 80 ? `${event.data.slice(0, 80)}…` : event.data;
}

function EventRow({ event }: { event: LabSseEvent }) {
  return (
    <li className="border-b last:border-b-0">
      <details>
        <summary className="flex cursor-pointer items-baseline gap-3 px-3 py-1.5 text-xs hover:bg-muted">
          <span className="w-6 shrink-0 text-right text-muted-foreground tabular-nums">{event.index}</span>
          <span className="shrink-0 font-mono">{event.type ?? event.event}</span>
          <span className="min-w-0 truncate font-mono text-muted-foreground">{gist(event)}</span>
        </summary>
        <pre className="overflow-auto bg-muted/50 px-3 py-2 font-mono text-xs">{event.data}</pre>
      </details>
    </li>
  );
}

function ChatEvents({ events }: { events: LabChatEvent[] }) {
  const text = events.map((e) => e.delta ?? "").join("");
  const deltas = events.filter((e) => e.type === "text-delta").length;
  return (
    <Panel title={`What responsesChatModel yields (${events.length} events)`}>
      <div className="flex flex-col gap-2 p-3 text-sm">
        {deltas ? (
          <p>
            <span className="text-muted-foreground tabular-nums">{deltas} text deltas: </span>
            {text}
          </p>
        ) : null}
        {events.map((event, i) =>
          event.type === "text-delta" ? null : (
            <pre key={i} className="overflow-auto rounded-md bg-muted/50 px-2 py-1 font-mono text-xs">
              {event.json}
            </pre>
          ),
        )}
      </div>
    </Panel>
  );
}
