import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { DiffResult } from "./workshop-server";

import { SolutionDiff } from "./solution-diff";

/** A diff line, matched exactly: its leading spaces are the point. */
const line = (text: string) => (_: string, element: Element | null) =>
  element?.tagName === "SPAN" && element.textContent === text;

const PATCH = `--- playground/chunk.ts
+++ solution/chunk.ts
@@ -1,3 +1,3 @@
 export function pack() {
-  throw new Error("not written");
+  return windows;
 }
`;

describe("SolutionDiff", () => {
  it("stays hidden, and asks for nothing, until the button is pressed", async () => {
    const load = vi.fn(async (): Promise<DiffResult> => ({
      files: [{ path: "chunk.ts", changed: true, diff: PATCH }],
    }));
    render(<SolutionDiff stepId="04.1" load={load} />);
    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByText(/return windows/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show the solution diff" }));
    expect(load).toHaveBeenCalledWith("04.1");
    const added = await screen.findByText(line("+  return windows;"));
    expect(added).toHaveClass("bg-primary/10");
    expect(screen.getByText(line('-  throw new Error("not written");'))).toHaveClass("bg-destructive/10");
    expect(screen.getByText(/^playground\/chunk\.ts$/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByText(line("+  return windows;"))).toBeNull();
    expect(screen.getByRole("button", { name: "Show the solution diff" })).toBeInTheDocument();
  });

  it("says when the playground matches, and passes on ex's refusal", async () => {
    const load = vi
      .fn<(stepId: string) => Promise<DiffResult>>()
      .mockResolvedValueOnce({ files: [{ path: "chunk.ts", changed: false, diff: "" }] })
      .mockResolvedValueOnce({
        error: "step 04.1 isn't active (active: none)",
        detail: "run `pnpm ex start 04.1` first",
      });
    render(<SolutionDiff stepId="04.1" load={load} />);
    fireEvent.click(screen.getByRole("button", { name: "Show the solution diff" }));
    expect(await screen.findByText("Your playground matches the solution.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("step 04.1 isn't active (active: none)"));
  });
});
