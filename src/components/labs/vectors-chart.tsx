import type { VectorVariant } from "@/components/labs/vectors-server";

import { cn } from "@/lib/utils";

const KINDS: { kind: VectorVariant["kind"]; label: string; dot: string }[] = [
  { kind: "exact", label: "exact scan", dot: "fill-foreground" },
  { kind: "hnsw", label: "HNSW, vector(1536)", dot: "fill-chart-2" },
  { kind: "truncated", label: "truncated", dot: "fill-chart-3" },
  { kind: "halfvec", label: "halfvec", dot: "fill-chart-4" },
  { kind: "bit", label: "bit", dot: "fill-chart-5" },
];

const WIDTH = 640;
const HEIGHT = 300;
const PAD = { left: 44, right: 16, top: 12, bottom: 32 };

/** Recall@10 against median latency, one dot per variant. Latency is on a log scale: the exact scan is 10× slower. */
export function RecallLatencyChart({ variants }: { variants: VectorVariant[] }) {
  const ms = variants.map((v) => v.medianMs);
  const lo = Math.log10(Math.min(...ms) * 0.8);
  const hi = Math.log10(Math.max(...ms) * 1.25);
  const floor = Math.max(0, Math.floor(Math.min(...variants.map((v) => v.recall)) * 10) / 10 - 0.05);
  const x = (value: number) => PAD.left + ((Math.log10(value) - lo) / (hi - lo)) * (WIDTH - PAD.left - PAD.right);
  const y = (recall: number) => PAD.top + ((1 - recall) / (1 - floor)) * (HEIGHT - PAD.top - PAD.bottom);
  const ticks = [0.5, 1, 2, 5, 10, 20, 50, 100].filter((t) => Math.log10(t) >= lo && Math.log10(t) <= hi);
  const recallTicks = Array.from({ length: Math.round((1 - floor) / 0.1) + 1 }, (_, i) => 1 - i * 0.1).filter(
    (r) => r >= floor - 1e-9,
  );

  return (
    <figure className="flex flex-col gap-2">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full" role="img" aria-label="Recall against latency">
        {recallTicks.map((r) => (
          <g key={r}>
            <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(r)} y2={y(r)} className="stroke-border" />
            <text x={PAD.left - 6} y={y(r) + 4} textAnchor="end" className="fill-muted-foreground text-[11px]">
              {Math.round(r * 100)}%
            </text>
          </g>
        ))}
        {ticks.map((t) => (
          <text
            key={t}
            x={x(t)}
            y={HEIGHT - PAD.bottom + 16}
            textAnchor="middle"
            className="fill-muted-foreground text-[11px]"
          >
            {t} ms
          </text>
        ))}
        {variants.map((v) => (
          <g key={v.name}>
            <circle
              cx={x(v.medianMs)}
              cy={y(v.recall)}
              r={5}
              className={cn("stroke-background", KINDS.find((k) => k.kind === v.kind)?.dot)}
            >
              <title>{`${v.name}: ${(v.recall * 100).toFixed(1)}% in ${v.medianMs.toFixed(2)} ms`}</title>
            </circle>
            <text x={x(v.medianMs) + 8} y={y(v.recall) + 4} className="fill-foreground text-[10px]">
              {shortName(v.name)}
            </text>
          </g>
        ))}
      </svg>
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {KINDS.map((k) => (
          <span key={k.kind} className="flex items-center gap-1.5">
            <svg viewBox="0 0 10 10" className="size-2.5" aria-hidden>
              <circle cx={5} cy={5} r={5} className={k.dot} />
            </svg>
            {k.label}
          </span>
        ))}
        <span>Recall@10 up, median latency across (log scale).</span>
      </figcaption>
    </figure>
  );
}

function shortName(name: string): string {
  return name
    .replace("vector(1536), ", "")
    .replace(", truncated, HNSW", "")
    .replace("(1536), HNSW", "")
    .replace("bit(1536), ", "bit, ")
    .replace("HNSW, ef_search ", "ef ");
}
