import { describe, expect, it } from "vitest";

import { changeFireKey, dueSlot, inFolder, NewAutomationSchema, normalizeFolder, runMessage } from "./automation";
import { CronError, latestSlot, nextAfter, parseCron } from "./cron";

const at = (iso: string) => new Date(iso);

describe("cron", () => {
  it("finds the next time for common schedules", () => {
    const from = at("2026-10-14T09:17:30Z");
    expect(nextAfter(parseCron("*/15 * * * *"), from)).toEqual(at("2026-10-14T09:30:00Z"));
    expect(nextAfter(parseCron("0 9 * * *"), from)).toEqual(at("2026-10-15T09:00:00Z"));
    // Weekdays at 08:30: the 14th is a Wednesday, so Friday the 16th, then Monday the 19th.
    expect(nextAfter(parseCron("30 8 * * 1-5"), at("2026-10-16T09:00:00Z"))).toEqual(at("2026-10-19T08:30:00Z"));
    expect(nextAfter(parseCron("0 0 1 */3 *"), from)).toEqual(at("2027-01-01T00:00:00Z"));
    expect(nextAfter(parseCron("0 12 * * 7"), from)).toEqual(at("2026-10-18T12:00:00Z"));
  });

  it("matches either day field when both are restricted, as classic cron does", () => {
    // The 20th, or any Monday: Monday the 19th comes first.
    expect(nextAfter(parseCron("0 0 20 * 1"), at("2026-10-14T00:00:00Z"))).toEqual(at("2026-10-19T00:00:00Z"));
  });

  it("refuses expressions it can't read or that never fire", () => {
    for (const bad of ["* * * *", "60 * * * *", "a * * * *", "5-1 * * * *", "*/0 * * * *", "0 0 30 2 *"]) {
      expect(() => parseCron(bad)).toThrow(CronError);
    }
  });

  it("gives the latest slot in a window, or null", () => {
    const cron = parseCron("0 * * * *");
    expect(latestSlot(cron, at("2026-10-14T06:10:00Z"), at("2026-10-14T09:59:00Z"))).toEqual(
      at("2026-10-14T09:00:00Z"),
    );
    expect(latestSlot(cron, at("2026-10-14T09:00:00Z"), at("2026-10-14T09:59:00Z"))).toBeNull();
  });
});

describe("automations", () => {
  it("fires the latest due slot once, never one from before it was made, and drops slots past the catch-up", () => {
    const createdAt = at("2026-10-14T08:30:00Z");
    const now = at("2026-10-14T11:05:00Z");
    expect(dueSlot("0 * * * *", { now, createdAt, lastFiredAt: null })).toEqual(at("2026-10-14T11:00:00Z"));
    expect(dueSlot("0 * * * *", { now, createdAt, lastFiredAt: at("2026-10-14T11:00:00Z") })).toBeNull();
    expect(dueSlot("0 8 * * *", { now, createdAt, lastFiredAt: null })).toBeNull();
    expect(
      dueSlot("0 0 * * *", { now: at("2026-10-20T11:00:00Z"), createdAt, lastFiredAt: at("2026-10-15T00:00:00Z") }),
    ).toEqual(at("2026-10-20T00:00:00Z"));
  });

  it("matches documents inside a folder, at any depth", () => {
    expect(normalizeFolder("HR//Policies/")).toBe("/HR/Policies");
    expect(inFolder("/HR/Policies", "/HR/Policies/Travel and Expenses Policy v2.pdf")).toBe(true);
    expect(inFolder("/HR", "/HR/Policies/Leave.pdf")).toBe(true);
    expect(inFolder("/HR/Policies", "/HR/Policies Archive/old.pdf")).toBe(false);
    expect(inFolder("/", "/anything.pdf")).toBe(true);
  });

  it("validates a new automation", () => {
    const ok = NewAutomationSchema.safeParse({
      name: "Policy digest",
      prompt: "Summarise it",
      trigger: { kind: "schedule", cron: "0 9 * * 1", folder: "HR/Policies/" },
    });
    expect(ok.success && ok.data.trigger).toEqual({ kind: "schedule", cron: "0 9 * * 1", folder: "/HR/Policies" });
    expect(
      NewAutomationSchema.safeParse({
        name: "x",
        prompt: "y",
        trigger: { kind: "schedule", cron: "nope", folder: null },
      }).success,
    ).toBe(false);
    expect(NewAutomationSchema.safeParse({ name: "x", prompt: "y", trigger: { kind: "drive_change" } }).success).toBe(
      false,
    );
  });

  it("gives a run's message the document's id alone, and keys a drive change by version", () => {
    // A title is whatever the document's author typed, and the run plans from this message: it gets the id only.
    expect(runMessage("Summarise it", "d1")).toBe("Summarise it\n\nThe document's id: d1. Read it with read_document.");
    expect(runMessage("Summarise", null)).toBe("Summarise");
    expect(changeFireKey("d1", 3)).toBe("doc:d1:v3");
  });
});
