/**
 * Section 20's drills, as `pnpm ex drill list` shows them. Each title is what someone would report; everything
 * else is sealed (`./seal`), so reading this file, or `git diff` after a drill is planted, gives nothing away.
 */
import type { DrillEntry } from "./types";

import { SEALED } from "./sealed";

const entry = (id: string, title: string): DrillEntry => {
  const sealed = SEALED[id];
  if (!sealed) throw new Error(`drill ${id} has no sealed fault`);
  return { id, title, sealed };
};

export const DRILLS: DrillEntry[] = [
  entry("leaver", "Someone off the exec team still reads its documents"),
  entry("paraphrase", "Questions in your own words miss the policies"),
  entry("ranking", "The answers are a bit off"),
  entry("stuck-edits", "Kestrel's edits stopped arriving"),
  entry("digest", "The overnight digest ran at the wrong time"),
];
