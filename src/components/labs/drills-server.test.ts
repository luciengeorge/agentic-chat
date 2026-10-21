// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";

import type { DrillEntry, Fault } from "@/core/drills/types";

import { seal } from "@/core/drills/seal";

import { makeRepo, readme } from "../../../scripts/ex/test-repo";
import { drillBoard } from "./drills-server";

const fault = (symptom: string): Fault => ({
  symptom,
  cause: "secret",
  clues: [],
  modules: [],
  needs: [],
  requires: [],
  files: [],
  plant: [],
  undo: [],
  probes: [],
  test: "",
});
const DRILLS: DrillEntry[] = [
  { id: "first", title: "The first is off", sealed: seal("first", fault("first broke at {{planted}}")) },
  { id: "second", title: "The second is off", sealed: seal("second", fault("second broke")) },
];
const LAB = (title: string) => readme({ title, type: "lab" });

let cleanup = () => {};
afterEach(() => cleanup());

describe("drillBoard", () => {
  it("lists each drill with its step and state, and the planted one's report", () => {
    const repo = makeRepo({
      "exercises/20.drills/README.md": readme({ title: "Drills" }),
      "exercises/20.drills/01.problem.first/README.md": LAB("The first is off"),
      "exercises/20.drills/01.solution.first/README.md": LAB("The first is off"),
      ".ex/drill.json": JSON.stringify({
        active: seal("journal", {
          id: "first",
          phase: "planted",
          plantedAt: "2026-10-21T09:15:00.000Z",
          vars: { planted: "11:15" },
          files: [],
        }),
        passed: ["second"],
      }),
    });
    cleanup = repo.cleanup;
    const board = drillBoard(repo.root, DRILLS);
    expect(board.drills.map((row) => [row.id, row.step, row.planted, row.passed])).toEqual([
      ["first", "20.1", true, false],
      ["second", null, false, true],
    ]);
    expect(board.planted?.symptom).toBe("first broke at 11:15");
    expect(JSON.stringify(board), "the cause stays sealed").not.toContain("secret");
  });
});
