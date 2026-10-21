import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Checked, DrillView } from "./workshop-server";

import { DrillPanel } from "./drill-panel";

const IDLE: DrillView = {
  id: "leaver",
  title: "Someone off the exec team still reads its documents",
  planted: false,
  plantedAt: null,
  symptom: null,
  other: null,
  passed: false,
  needsReset: false,
};
const PLANTED: DrillView = {
  ...IDLE,
  planted: true,
  plantedAt: "2026-10-21T09:15:00.000Z",
  symptom: "Kestrel's IT took Priya Nair off the exec team.\nThe sync reported no errors.\n\nPriya can still read it.",
};

const CHECKED: Checked = {
  drill: "leaver",
  passed: false,
  symptom: {
    gone: false,
    probes: [
      { ok: true, detail: "fine" },
      { ok: false, detail: "priya.nair can still read the Project Heron board memo" },
    ],
  },
  test: {
    passed: false,
    tests: [
      { name: "a removed member loses the group", outcome: "passed", message: null },
      { name: "a member two levels up loses both", outcome: "failed", message: "expected 2 rows to be 0\nat line 4" },
    ],
    error: null,
  },
  warnings: [],
};

function renderPanel(drill: DrillView, check = vi.fn()) {
  const onPlant = vi.fn();
  const onReset = vi.fn();
  render(<DrillPanel drill={drill} busy={false} onPlant={onPlant} onReset={onReset} check={check} />);
  return { onPlant, onReset, check };
}

describe("DrillPanel", () => {
  it("plants only after a confirm that says what planting does", () => {
    const { onPlant } = renderPanel(IDLE);
    fireEvent.click(screen.getByRole("button", { name: "Plant the fault" }));
    expect(onPlant).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("clear the dev server's terminal");
    fireEvent.click(within(dialog).getByRole("button", { name: "Plant it" }));
    expect(onPlant).toHaveBeenCalledOnce();
  });

  it("shows the planted drill's report as paragraphs, and resets only after a confirm", () => {
    const { onReset } = renderPanel(PLANTED);
    expect(screen.getByText(/Priya Nair off the exec team\. The sync reported no errors\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Plant the fault" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Reset" }));
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("checks the fix and shows what's still wrong, in plain text", async () => {
    const check = vi.fn(async () => ({ result: { checked: CHECKED }, busy: null }));
    renderPanel(PLANTED, check);
    fireEvent.click(screen.getByRole("button", { name: "Check my fix" }));
    expect(await screen.findByText("Not fixed yet.")).toBeInTheDocument();
    expect(screen.getByText("The symptom is still there.")).toBeInTheDocument();
    expect(screen.getByText("priya.nair can still read the Project Heron board memo")).toBeInTheDocument();
    expect(screen.queryByText("fine")).toBeNull();
    expect(screen.getByText("The fault's test fails (1 of 2 pass).")).toBeInTheDocument();
    expect(screen.getByText("a member two levels up loses both")).toBeInTheDocument();
  });

  it("passes on a refusal, and says when another drill is planted", async () => {
    const check = vi.fn(async () => ({ result: null, busy: "`ex drill reset` is still running. Wait for it." }));
    renderPanel(PLANTED, check);
    fireEvent.click(screen.getByRole("button", { name: "Check my fix" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("`ex drill reset` is still running");

    renderPanel({ ...IDLE, id: "digest", other: "leaver" });
    expect(screen.getByText(/is planted\. Reset it before planting this one\./)).toBeInTheDocument();
  });
});
