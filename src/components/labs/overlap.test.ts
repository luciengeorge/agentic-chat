import { describe, expect, it } from "vitest";

import { repeats } from "./overlap";

describe("repeats", () => {
  it("finds the sentences a chunk repeats from the end of the one before", () => {
    const prev = "One. Two. Three.";
    expect(repeats(prev, "Two. Three. Four.")).toEqual({ header: 0, overlap: "Two. Three.".length });
  });

  it("finds nothing for the first chunk, or when nothing repeats", () => {
    expect(repeats(null, "One.")).toEqual({ header: 0, overlap: 0 });
    expect(repeats("One. Two.", "Three. Four.")).toEqual({ header: 0, overlap: 0 });
  });

  it("only cuts where a word ends", () => {
    expect(repeats("The fee is 50", "500 a month.")).toEqual({ header: 0, overlap: 0 });
  });

  it("skips a repeated table header, then finds the repeated rows", () => {
    const header = "| No. | Owner |\n| --- | --- |";
    const prev = `${header}\n| 1 | Emily |\n| 2 | Tom |`;
    expect(repeats(prev, `${header}\n| 2 | Tom |\n| 3 | Maya |`)).toEqual({
      header: header.length + 1,
      overlap: "| 2 | Tom |".length,
    });
  });
});
