/**
 * The drills lab (section 20): each drill's state, and the planted one's report, as `ex drill <id>` printed it.
 * It shows symptoms only, never a cause, and reads `.ex/` in-process, so it's dev only.
 */
import type { DrillEntry } from "@/core/drills/types";

import { type DrillView, readDrill } from "@/components/workshop/workshop-server";
import { DRILLS } from "@/core/drills/catalog";

import { listSections } from "../../../scripts/ex/list";

export type BoardDrill = DrillView & { step: string | null };

export function drillBoard(root: string, drills: readonly DrillEntry[] = DRILLS) {
  const steps = new Map(
    (listSections(root).find((section) => section.slug === "drills")?.steps ?? []).map((step) => [step.slug, step.id]),
  );
  const rows: BoardDrill[] = drills.map((drill) => ({
    ...readDrill(root, drill.id, drills)!,
    step: steps.get(drill.id) ?? null,
  }));
  return { drills: rows, planted: rows.find((row) => row.planted) ?? null };
}
