import { Alert02Icon, File02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

import type { ChatUIMessage, SourceRef, Verdict } from "./types";

import { CitationChip, collapseRuns, resolveCitations, toOpenSource, type OpenSource } from "./citations";
import { Markdown, withoutOpenCitation } from "./markdown";

export function UserMessage({ message }: { message: ChatUIMessage }) {
  const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-[0.9375rem] leading-relaxed whitespace-pre-wrap">
        {text}
      </div>
    </div>
  );
}

function partsOf(message: ChatUIMessage) {
  let text = "";
  let sources: SourceRef[] = [];
  let verdict: Verdict | undefined;
  for (const part of message.parts) {
    if (part.type === "text") text += part.text;
    else if (part.type === "data-sources") sources = part.data.sources;
    else if (part.type === "data-verdict") verdict = part.data;
  }
  return { text, sources, verdict };
}

export function AssistantMessage({
  message,
  streaming,
  onOpenSource,
}: {
  message: ChatUIMessage;
  streaming: boolean;
  onOpenSource: (source: OpenSource) => void;
}) {
  const { text, sources, verdict } = partsOf(message);
  const shown = streaming ? withoutOpenCitation(text) : text;
  const { resolved, cited } = resolveCitations(shown, sources, verdict);
  const body = collapseRuns(shown, resolved);
  const stopped = message.metadata?.status === "aborted";

  if (!shown && streaming) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Spinner className="size-3.5" />
        {sources.length
          ? `Reading ${sources.length} ${sources.length === 1 ? "source" : "sources"}…`
          : "Searching your documents…"}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        className={cn(
          "prose prose-sm max-w-none text-[0.9375rem] leading-relaxed text-foreground prose-zinc dark:prose-invert",
          "prose-headings:mt-4 prose-headings:mb-2 prose-headings:font-semibold prose-p:my-2 prose-ol:my-2 prose-ul:my-2 prose-li:my-0.5",
          "prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:font-normal prose-code:before:content-none prose-code:after:content-none",
          verdict?.abstained && "text-muted-foreground",
        )}
      >
        <Markdown
          text={body}
          renderCitation={(marker, key) => {
            const entry = resolved.get(marker);
            return entry ? <CitationChip key={key} resolved={entry} onOpen={onOpenSource} /> : null;
          }}
        />
        {streaming ? (
          <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-foreground/40 align-middle" />
        ) : null}
      </div>

      {stopped ? <p className="text-xs text-muted-foreground">Stopped before the answer finished.</p> : null}

      {verdict?.flagged ? (
        <p className="flex items-start gap-2 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="mt-px size-3.5 shrink-0" />
          {verdict.dropped.length
            ? `${verdict.dropped.length === 1 ? "One citation" : `${verdict.dropped.length} citations`} didn't match the sources and ${verdict.dropped.length === 1 ? "was" : "were"} removed. Check the claims that lost theirs.`
            : "This answer doesn't cite the documents, so nothing in it is checked. Treat it with care."}
        </p>
      ) : null}

      {cited.length ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Sources</span>
          <ul className="flex flex-wrap gap-2">
            {cited.map(({ n, citation }) => (
              <li key={citation.chunkId}>
                <button
                  type="button"
                  onClick={() => onOpenSource(toOpenSource(citation))}
                  className="group flex max-w-72 items-center gap-2 rounded-lg border bg-card px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  <span className="flex size-4 shrink-0 items-center justify-center rounded bg-primary/10 text-[0.65rem] font-semibold text-primary tabular-nums">
                    {n}
                  </span>
                  <HugeiconsIcon
                    icon={File02Icon}
                    strokeWidth={2}
                    className="size-3.5 shrink-0 text-muted-foreground"
                  />
                  <span className="truncate font-medium">{citation.title}</span>
                  {citation.page ? (
                    <span className="shrink-0 text-muted-foreground tabular-nums">p. {citation.page}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
