import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { TestEvent } from "./workshop-server";

import { TestResults } from "./test-results";
import { IDLE, reduceRun } from "./test-run";

const FILE = "exercises/04.chunking/01.problem.token-sizing/chunk.test.ts";
const fold = (events: TestEvent[]) => events.reduce(reduceRun, IDLE);

const STARTED: TestEvent[] = [
  { type: "started", step: "04.1", target: "playground" },
  {
    type: "collected",
    nodeids: [`${FILE} > pack > never goes over the target`, `${FILE} > splits page 2 at 494 tokens`],
  },
];

describe("TestResults", () => {
  it("lists every test as soon as it's collected, and ticks each off as it ends", () => {
    const { rerender } = render(<TestResults view={fold(STARTED)} />);
    expect(screen.getByText("Running against your playground: 0 of 2 done")).toBeInTheDocument();
    expect(screen.getAllByLabelText("running")).toHaveLength(2);
    expect(screen.getByText("pack")).toBeInTheDocument();

    const one: TestEvent = {
      type: "test",
      test: {
        nodeid: `${FILE} > pack > never goes over the target`,
        outcome: "passed",
        duration_s: 0.01,
        message: null,
      },
    };
    rerender(<TestResults view={fold([...STARTED, one])} />);
    expect(screen.getByText("Running against your playground: 1 of 2 done")).toBeInTheDocument();
    expect(screen.getAllByLabelText("passed")).toHaveLength(1);
  });

  it("shows each failure's message as plain text, and the final summary", () => {
    const view = fold([
      ...STARTED,
      {
        type: "done",
        run: {
          step: "04.1",
          target: "playground",
          passed: false,
          tests: [
            {
              nodeid: `${FILE} > pack > never goes over the target`,
              outcome: "passed",
              duration_s: 0.01,
              message: null,
            },
            {
              nodeid: `${FILE} > splits page 2 at 494 tokens`,
              outcome: "failed",
              duration_s: 0.2,
              message: "\u001b[31mAssertionError\u001b[39m: expected 517 to be 494",
            },
          ],
          warnings: ["Postgres is unreachable, so this step's database tests were skipped."],
        },
      },
    ]);
    render(<TestResults view={view} />);
    expect(screen.getByText("Failed against your playground: 1 of 2 tests")).toHaveClass("text-destructive");
    const failed = screen.getByText("splits page 2 at 494 tokens").closest("li")!;
    expect(failed).toHaveAttribute("data-outcome", "failed");
    expect(within(failed).getByLabelText("failed")).toBeInTheDocument();
    expect(within(failed).getByText("AssertionError: expected 517 to be 494").tagName).toBe("PRE");
    expect(screen.getByText(/Postgres is unreachable/)).toBeInTheDocument();
  });

  it("says passed when every test passed, and names a file that couldn't run", () => {
    const passed = fold([
      { type: "started", step: "04.1", target: "solution" },
      {
        type: "done",
        run: {
          step: "04.1",
          target: "solution",
          passed: true,
          tests: [
            { nodeid: `${FILE} > splits page 2 at 494 tokens`, outcome: "passed", duration_s: 0.2, message: null },
          ],
          warnings: [],
        },
      },
    ]);
    const { rerender } = render(<TestResults view={passed} />);
    expect(screen.getByText("Passed against the solution code: 1 of 1 tests")).toHaveClass("text-primary");

    const broken = fold([
      { type: "started", step: "04.1", target: "playground" },
      {
        type: "done",
        run: {
          step: "04.1",
          target: "playground",
          passed: false,
          tests: [{ nodeid: FILE, outcome: "error", duration_s: 0, message: "SyntaxError: Unexpected token" }],
          warnings: [],
        },
      },
    ]);
    rerender(<TestResults view={broken} />);
    expect(screen.getByText("chunk.test.ts (could not run)")).toBeInTheDocument();
    expect(screen.getByText("SyntaxError: Unexpected token")).toBeInTheDocument();
  });

  it("shows why a run couldn't start, and a dropped connection", () => {
    const { rerender } = render(
      <TestResults
        view={fold([
          { type: "started", step: "04.2", target: "playground" },
          {
            type: "failed",
            error: { error: "step 04.2 isn't active (active: 04.1)", detail: "run `pnpm ex start 04.2` first" },
          },
        ])}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("step 04.2 isn't active (active: 04.1)");
    expect(screen.getByRole("alert")).toHaveTextContent("run `pnpm ex start 04.2` first");
    rerender(<TestResults view={{ ...fold(STARTED), status: "dropped" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/connection dropped/);
  });
});
