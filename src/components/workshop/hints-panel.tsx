import { useState } from "react";

import { cn } from "@/lib/utils";

import { HINT_LEGEND, type Hint, type HintEmoji } from "./hints";
import { inline } from "./readme";

/** The legend, as a row of toggles: each shows or hides one kind of hint. */
function Legend({
  counts,
  hidden,
  toggle,
}: {
  counts: Map<HintEmoji, number>;
  hidden: Set<HintEmoji>;
  toggle: (emoji: HintEmoji) => void;
}) {
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Hint legend">
      {HINT_LEGEND.filter((hint) => counts.has(hint.emoji)).map((hint) => (
        <li key={hint.emoji}>
          <button
            type="button"
            aria-pressed={!hidden.has(hint.emoji)}
            title={hint.meaning}
            onClick={() => toggle(hint.emoji)}
            className={cn(
              "flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors hover:bg-muted",
              hidden.has(hint.emoji) && "opacity-50",
            )}
          >
            <span aria-hidden>{hint.emoji}</span>
            {hint.label}
            <span className="text-muted-foreground tabular-nums">{counts.get(hint.emoji)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The problem file's hints, in the file's order, which is the order of the work. */
export function HintsPanel({ hints, files }: { hints: Hint[]; files: string[] }) {
  const [hidden, setHidden] = useState<Set<HintEmoji>>(new Set());
  if (!hints.length) return <p className="text-sm text-muted-foreground">This step's files hold no hints.</p>;
  const counts = new Map<HintEmoji, number>();
  for (const hint of hints) counts.set(hint.emoji, (counts.get(hint.emoji) ?? 0) + 1);
  const toggle = (emoji: HintEmoji) =>
    setHidden((all) => {
      const next = new Set(all);
      if (!next.delete(emoji)) next.add(emoji);
      return next;
    });
  const meaning = new Map<string, string>(HINT_LEGEND.map((hint) => [hint.emoji, hint.meaning]));

  return (
    <div className="flex flex-col gap-4">
      <Legend counts={counts} hidden={hidden} toggle={toggle} />
      <ol className="flex flex-col gap-3">
        {hints
          .filter((hint) => !hidden.has(hint.emoji))
          .map((hint) => (
            <li key={`${hint.file}:${hint.line}`} className="flex gap-2.5 text-sm leading-relaxed">
              <span
                className="shrink-0 select-none"
                role="img"
                aria-label={meaning.get(hint.emoji)}
                title={meaning.get(hint.emoji)}
              >
                {hint.emoji}
              </span>
              <div className="flex min-w-0 flex-col gap-0.5 [&_a]:break-all [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:text-[0.85em]">
                <p>{inline(hint.text, `${hint.file}-${hint.line}`)}</p>
                <span className="font-mono text-[0.6875rem] text-muted-foreground">
                  {files.length > 1 ? `${hint.file}:` : "line "}
                  {hint.line}
                </span>
              </div>
            </li>
          ))}
      </ol>
    </div>
  );
}
