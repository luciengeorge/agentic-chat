import type { ReactNode } from "react";

import { parseCitations, type Citation } from "#learn/cite/citations";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import type { SourceRef, Verdict } from "./types";

/** What a citation chip opens: one chunk of one document, at a page. */
export interface OpenSource {
  label: string;
  chunkId: string;
  documentId: string;
  title: string;
  path: string;
  page: number | null;
  quote: string | null;
}

type Resolved =
  | { state: "valid"; n: number; citation: Citation }
  | { state: "pending"; n: number; source: SourceRef }
  | { state: "hidden" };

/**
 * How each citation marker in a reply shows. Once the verdict is in, a marker is a numbered chip if the validator
 * kept it, and disappears if it dropped it. While the reply streams, a marker whose label names a source shows as a
 * pending chip. Numbers follow first appearance, one per label.
 */
export function resolveCitations(text: string, sources: SourceRef[], verdict: Verdict | undefined) {
  const valid = new Map(verdict?.citations.map((c) => [c.marker, c]));
  const byLabel = new Map(sources.map((s) => [s.label, s]));
  const numbers = new Map<string, number>();
  const resolved = new Map<string, Resolved>();

  for (const { marker, label } of parseCitations(text)) {
    if (resolved.has(marker)) continue;
    const citation = valid.get(marker);
    const source = byLabel.get(label);
    const shown = verdict ? citation : source;
    if (!shown) {
      resolved.set(marker, { state: "hidden" });
      continue;
    }
    if (!numbers.has(label)) numbers.set(label, numbers.size + 1);
    const n = numbers.get(label)!;
    resolved.set(marker, citation ? { state: "valid", n, citation } : { state: "pending", n, source: source! });
  }

  const cited = [...resolved.values()].flatMap((r) => (r.state === "valid" ? [{ n: r.n, citation: r.citation }] : []));
  const documents = new Map<string, { n: number; citation: Citation }>();
  for (const entry of cited) if (!documents.has(entry.citation.chunkId)) documents.set(entry.citation.chunkId, entry);

  return { resolved, cited: [...documents.values()].sort((a, b) => a.n - b.n) };
}

const RUN = /\[\[(?:(?!\]\]).)+\]\](?:\s*\[\[(?:(?!\]\]).)+\]\])+/gs;
const ONE = /\[\[(?:(?!\]\]).)+\]\]/gs;

/** Markers side by side that show the same number ("2 2") become one chip. */
export function collapseRuns(text: string, resolved: Map<string, Resolved>): string {
  return text.replace(RUN, (run) => {
    const seen = new Set<number>();
    return [...run.matchAll(ONE)]
      .map(([marker]) => {
        const entry = resolved.get(marker);
        if (!entry || entry.state === "hidden" || seen.has(entry.n)) return "";
        seen.add(entry.n);
        return marker;
      })
      .join("");
  });
}

export const toOpenSource = (citation: Citation): OpenSource => ({
  label: citation.label,
  chunkId: citation.chunkId,
  documentId: citation.documentId,
  title: citation.title,
  path: citation.path,
  page: citation.page,
  quote: citation.quote,
});

export function CitationChip({
  resolved,
  onOpen,
}: {
  resolved: Resolved;
  onOpen: (source: OpenSource) => void;
}): ReactNode {
  if (resolved.state === "hidden") return null;
  const pending = resolved.state === "pending";
  const title = pending ? resolved.source.title : resolved.citation.title;
  const page = pending ? resolved.source.pageStart : resolved.citation.page;

  const chip = (
    <TooltipTrigger
      render={
        <button
          type="button"
          disabled={pending}
          aria-label={`Source ${resolved.n}: ${title}${page ? `, page ${page}` : ""}`}
          onClick={pending ? undefined : () => onOpen(toOpenSource(resolved.citation))}
          className={cn(
            "mx-0.5 inline-flex h-[1.35em] min-w-[1.35em] translate-y-[-0.1em] items-center justify-center rounded-md px-1 align-middle text-[0.7rem] font-semibold tabular-nums transition-colors",
            pending
              ? "bg-muted text-muted-foreground"
              : "bg-primary/10 text-primary hover:bg-primary/20 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
          )}
        />
      }
    >
      {resolved.n}
    </TooltipTrigger>
  );

  return (
    <Tooltip>
      {chip}
      <TooltipContent className="max-w-xs">
        <div className="flex flex-col gap-1 text-left">
          <span className="font-medium">
            {title}
            {page ? <span className="font-normal opacity-70"> · p. {page}</span> : null}
          </span>
          {pending ? (
            <span className="opacity-70">Checking this citation…</span>
          ) : (
            <span className="italic opacity-80">“{resolved.citation.quote}”</span>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
