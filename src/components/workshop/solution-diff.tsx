import { GitCompareIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

import type { DiffResult, FileDiff } from "./workshop-server";

function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-muted-foreground";
  if (line.startsWith("@@")) return "bg-muted text-muted-foreground";
  if (line.startsWith("+")) return "bg-primary/10";
  if (line.startsWith("-")) return "bg-destructive/10";
  return "";
}

function FilePatch({ file }: { file: FileDiff }) {
  const lines = file.diff.replace(/\n$/, "").split("\n");
  return (
    <div className="overflow-hidden rounded-lg border">
      <p className="border-b bg-muted/50 px-3 py-1.5 font-mono text-xs">playground/{file.path}</p>
      {file.changed ? (
        <pre className="overflow-x-auto py-1 font-mono text-xs leading-relaxed">
          {lines.map((line, i) => (
            <span key={i} className={cn("block px-3", lineClass(line))}>
              {line || " "}
            </span>
          ))}
        </pre>
      ) : (
        <p className="px-3 py-2 text-sm text-muted-foreground">Same as the solution.</p>
      )}
    </div>
  );
}

/**
 * `ex diff`: the playground against the solution, hidden until asked for, since looking is a choice. Lines marked +
 * are the solution's, lines marked − are yours.
 */
export function SolutionDiff({ stepId, load }: { stepId: string; load: (stepId: string) => Promise<DiffResult> }) {
  const [shown, setShown] = useState(false);
  const [result, setResult] = useState<DiffResult | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchDiff = async () => {
    setLoading(true);
    try {
      setResult(await load(stepId));
    } catch (error) {
      setResult({ error: error instanceof Error ? error.message : String(error), detail: null });
    } finally {
      setLoading(false);
    }
  };

  if (!shown) {
    return (
      <Button
        variant="outline"
        onClick={() => {
          setShown(true);
          void fetchDiff();
        }}
      >
        <HugeiconsIcon icon={GitCompareIcon} strokeWidth={2} data-icon="inline-start" />
        Show the solution diff
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 text-sm text-muted-foreground">
          Lines marked <span className="rounded bg-primary/10 px-1 font-mono">+</span> are the solution's;{" "}
          <span className="rounded bg-destructive/10 px-1 font-mono">−</span> are yours.
        </p>
        <Button variant="ghost" size="sm" onClick={() => void fetchDiff()} disabled={loading}>
          {loading ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} data-icon="inline-start" />
          )}
          Refresh
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setShown(false)}>
          Hide
        </Button>
      </div>
      {result === null ? (
        <p className="text-sm text-muted-foreground">Comparing…</p>
      ) : "error" in result ? (
        <p role="alert" className="rounded-lg border bg-muted px-3 py-2.5 text-sm">
          {result.error}
          {typeof result.detail === "string" ? (
            <span className="block text-muted-foreground">{result.detail}</span>
          ) : null}
        </p>
      ) : result.files.every((file) => !file.changed) ? (
        <p className="text-sm text-muted-foreground">Your playground matches the solution.</p>
      ) : (
        result.files.map((file) => <FilePatch key={file.path} file={file} />)
      )}
    </div>
  );
}
