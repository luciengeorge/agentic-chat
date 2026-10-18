import type { ReactNode } from "react";

import { toOpenSource, type OpenSource, type Resolved } from "#learn/frontend/citations";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

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
