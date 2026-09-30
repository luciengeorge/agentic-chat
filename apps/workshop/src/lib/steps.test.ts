import { describe, expect, it } from "vitest";

import { StepListSchema } from "./steps";

const list = {
  sections: [
    {
      id: "00",
      slug: "tour",
      title: "Tour",
      hidden: false,
      steps: [
        {
          id: "00.1",
          slug: "welcome",
          title: "Welcome",
          type: "guided",
          problem_dir: "exercises/00.tour/01.problem.welcome",
          solution_dir: "exercises/00.tour/01.solution.welcome",
          status: "not_started",
        },
      ],
    },
  ],
};

describe("StepListSchema", () => {
  it("accepts the ex list --json shape", () => {
    expect(StepListSchema.parse(list)).toEqual(list);
  });

  it.each([
    ["an unknown status", { status: "done" }],
    ["an unknown type", { type: "quiz" }],
    ["a missing title", { title: undefined }],
  ])("rejects %s", (_, override) => {
    const step = { ...list.sections[0]!.steps[0]!, ...override };
    expect(StepListSchema.safeParse({ sections: [{ ...list.sections[0], steps: [step] }] }).success).toBe(false);
  });
});
