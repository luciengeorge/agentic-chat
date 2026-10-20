import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderInApp } from "@/core/frontend/testing";

import type { SectionRow, StepRow } from "./workshop-server";

import { StepList } from "./step-list";

const step = (id: string, title: string, extra: Partial<StepRow> = {}): StepRow => ({
  id,
  slug: title.toLowerCase(),
  title,
  type: "graded",
  problem_dir: `exercises/x/${id}.problem`,
  solution_dir: `exercises/x/${id}.solution`,
  status: "not_started",
  passed: false,
  ...extra,
});

const SECTIONS: SectionRow[] = [
  {
    id: "00",
    slug: "tour",
    title: "Tour",
    hidden: false,
    steps: [step("00.1", "Run the app", { type: "guided" })],
  },
  {
    id: "04",
    slug: "chunking",
    title: "Chunking",
    hidden: false,
    steps: [
      step("04.1", "Token-based sizing", { status: "active", passed: true }),
      step("04.2", "Overlap"),
      step("04.3", "The lab", { type: "lab" }),
    ],
  },
  {
    id: "05",
    slug: "background",
    title: "Background work",
    hidden: false,
    steps: [step("05.1", "A queue", { status: "passed", passed: true })],
  },
];

describe("StepList", () => {
  it("opens the active step's section, marks the active and passed steps, and tags the ungraded ones", async () => {
    await renderInApp(() => <StepList sections={SECTIONS} />);
    const chunking = screen.getByRole("button", { name: /Chunking/ });
    expect(chunking).toHaveAttribute("aria-expanded", "true");
    expect(within(chunking).getByLabelText("1 of 2 graded steps passed")).toHaveTextContent("1/2");

    const active = screen.getByRole("link", { name: /04\.1 Token-based sizing/ });
    expect(active).toHaveAttribute("data-status", "active");
    expect(active).toHaveTextContent("(active, passed)");
    expect(screen.getByRole("link", { name: /04\.2 Overlap/ })).toHaveTextContent("(not started)");
    expect(screen.getByRole("link", { name: /04\.3 The lab/ })).toHaveTextContent(/lab/);
    expect(screen.getByRole("link", { name: "Introduction" })).toHaveAttribute("href", "/workshop/sections/04");

    // The other sections start folded, with their progress showing.
    expect(screen.getByRole("button", { name: /Tour/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: /00\.1/ })).toBeNull();
    expect(within(screen.getByRole("button", { name: /Background work/ })).getByText("1/1")).toHaveClass(
      "text-primary",
    );
  });

  it("opens the section of the step on screen too, and folds a section on click", async () => {
    await renderInApp(() => <StepList sections={SECTIONS} current="05.1" />);
    const passed = screen.getByRole("link", { name: /05\.1 A queue/ });
    expect(passed).toHaveAttribute("href", "/workshop/05.1");
    expect(passed).toHaveTextContent("(passed)");

    fireEvent.click(screen.getByRole("button", { name: /Chunking/ }));
    expect(screen.queryByRole("link", { name: /04\.1/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Tour/ }));
    expect(screen.getByRole("link", { name: /00\.1 Run the app/ })).toHaveTextContent(/guided/);
  });
});
