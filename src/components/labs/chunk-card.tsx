import { cn } from "@/lib/utils";

export interface LabChunk {
  ordinal: number;
  text: string;
  section: string | null;
  tokenCount: number;
  /** Characters at the start that repeat a table header from the chunk before. */
  header: number;
  /** Characters after the header that repeat the end of the chunk before. */
  overlap: number;
  overlapTokens: number;
}

/** One chunk: its size against the target, its section, and its text with the repeated parts shaded. */
export function ChunkCard({ chunk, target }: { chunk: LabChunk; target: number }) {
  const over = chunk.tokenCount > target;
  const { text, header, overlap } = chunk;
  return (
    <li className="flex flex-col gap-2 rounded-xl border px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
        <span className="font-medium">Chunk {chunk.ordinal}</span>
        <span className={cn("tabular-nums", over ? "font-medium text-destructive" : "text-muted-foreground")}>
          {chunk.tokenCount} / {target} tokens
        </span>
        {chunk.overlapTokens ? (
          <span className="text-muted-foreground tabular-nums">{chunk.overlapTokens} repeated</span>
        ) : null}
        {chunk.section ? <span className="min-w-0 truncate text-muted-foreground">§ {chunk.section}</span> : null}
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", over ? "bg-destructive" : "bg-primary")}
          style={{ width: `${Math.min(100, (chunk.tokenCount / target) * 100)}%` }}
        />
      </div>
      <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">
        {header ? <span className="rounded-sm bg-muted text-muted-foreground">{text.slice(0, header)}</span> : null}
        {overlap ? (
          <mark className="rounded-sm bg-primary/20 text-foreground">{text.slice(header, header + overlap)}</mark>
        ) : null}
        {text.slice(header + overlap)}
      </p>
    </li>
  );
}
