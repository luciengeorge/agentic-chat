import { File02Icon, LinkSquare02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";

import { documentHref, quotePattern, type OpenSource } from "#learn/frontend/citations";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { getCitedChunk } from "@/routes/chat/-functions";

import { Markdown } from "./markdown";

/** The cited chunk, quote marked, with a link that opens the original at the cited page. */
export function SourceSheet({ source, onClose }: { source: OpenSource | null; onClose: () => void }) {
  const chunk = useQuery({
    queryKey: ["cited-chunk", source?.chunkId],
    queryFn: () => getCitedChunk({ data: { chunkId: source!.chunkId } }),
    enabled: source !== null,
    staleTime: 60_000,
  });

  const href = source ? documentHref(source) : undefined;

  return (
    <Sheet open={source !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent className="w-full gap-0 sm:max-w-lg">
        {source ? (
          <>
            <SheetHeader className="gap-2 border-b pr-12">
              <div className="flex items-center gap-2 text-muted-foreground">
                <HugeiconsIcon icon={File02Icon} strokeWidth={2} className="size-4 shrink-0" />
                <span className="truncate font-mono text-xs">{source.path}</span>
              </div>
              <SheetTitle className="text-base leading-snug">{source.title}</SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-2">
                {source.page ? <Badge variant="secondary">Page {source.page}</Badge> : null}
                {chunk.data?.section ? <span className="truncate">{chunk.data.section}</span> : null}
              </SheetDescription>
            </SheetHeader>

            <div className="flex-1 overflow-y-auto p-4">
              {chunk.isPending ? (
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-4 w-11/12" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-4/5" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
              ) : chunk.data ? (
                <div className="prose prose-sm max-w-none text-foreground/90 prose-zinc dark:prose-invert prose-headings:text-sm prose-headings:font-semibold">
                  <Markdown text={chunk.data.text} renderCitation={() => null} highlight={quotePattern(source.quote)} />
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  This source is no longer available to you. The document may have changed or been unshared since the
                  answer was written.
                </p>
              )}
            </div>

            <SheetFooter className="border-t">
              {chunk.data ? (
                <a href={href} target="_blank" rel="noopener noreferrer" className={buttonVariants()}>
                  <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={2} data-icon="inline-start" />
                  {source.page ? `Open the document at page ${source.page}` : "Open the document"}
                </a>
              ) : null}
            </SheetFooter>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
