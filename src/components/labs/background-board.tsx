import type { Board, LabJob } from "@/components/labs/background-server";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const STATES = ["queued", "running", "done", "dead"] as const;

/** Jobs by queue and class (rows) and state (columns): the queue board. */
export function QueueBoard({ cells }: { cells: Board["cells"] }) {
  const rows = [...new Set(cells.map((cell) => `${cell.queue}\u0000${cell.class}`))];
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No jobs in your tenant yet.</p>;
  const count = (row: string, state: string) =>
    cells.find((cell) => `${cell.queue}\u0000${cell.class}` === row && cell.state === state)?.jobs ?? 0;
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b text-xs text-muted-foreground">
            <th className="px-3 py-2 font-medium">Queue</th>
            <th className="px-3 py-2 font-medium">Class</th>
            {STATES.map((state) => (
              <th key={state} className="px-3 py-2 text-right font-medium">
                {state}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const [queue, jobClass] = row.split("\u0000");
            return (
              <tr key={row} className="border-b last:border-0">
                <td className="max-w-48 truncate px-3 py-2 font-mono text-xs">
                  {queue.replace(/:[0-9a-f-]{36}$/, "")}
                </td>
                <td className="px-3 py-2">{jobClass}</td>
                {STATES.map((state) => (
                  <td key={state} className="px-3 py-2 text-right tabular-nums">
                    {count(row, state) || <span className="text-muted-foreground">0</span>}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The demo queue's jobs, oldest first, with who holds each running one. */
export function DemoJobs({ jobs }: { jobs: LabJob[] }) {
  if (jobs.length === 0) return <p className="text-sm text-muted-foreground">The demo queue is empty.</p>;
  return (
    <ol className="flex flex-col gap-1.5">
      {jobs.map((job, i) => (
        <li
          key={job.id}
          className={cn(
            "flex items-center gap-3 rounded-lg border px-3 py-1.5 text-sm",
            job.state === "running" && "border-primary/50 bg-primary/5",
            job.state === "done" && "text-muted-foreground",
          )}
        >
          <span className="w-6 text-right font-mono text-xs text-muted-foreground tabular-nums">{i + 1}</span>
          <Badge variant={job.class === "backfill" ? "outline" : "secondary"}>{job.class}</Badge>
          <span className="min-w-0 flex-1 truncate">{job.label}</span>
          <span className="text-xs tabular-nums">{job.state === "running" ? job.lockedBy : job.state}</span>
        </li>
      ))}
    </ol>
  );
}
