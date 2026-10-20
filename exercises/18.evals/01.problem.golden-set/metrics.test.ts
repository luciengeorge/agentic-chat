// @vitest-environment node
import { describe, expect, it } from "vitest";

import { hitsLabel, judge, type Label, type RankedChunk } from "#learn/eval/metrics";
import { readGoldenReport } from "@/core/eval/golden-report";

const pdf = (page: number, pageEnd = page): RankedChunk => ({ path: "/a.pdf", pageStart: page, pageEnd });
const MD: RankedChunk = { path: "/b.md", pageStart: null, pageEnd: null };

describe("hitsLabel", () => {
  it("matches a chunk of the labelled page, and only of the labelled document", () => {
    expect(hitsLabel({ path: "/a.pdf", page: 2 }, pdf(2))).toBe(true);
    expect(hitsLabel({ path: "/a.pdf", page: 2 }, pdf(3)), "page 3 isn't page 2").toBe(false);
    expect(
      hitsLabel({ path: "/a.pdf", page: 2 }, { ...pdf(2), path: "/z.pdf" }),
      "page 2 of another document finds nothing: the label names a document and a page",
    ).toBe(false);
  });

  it("matches a chunk whose range includes the page, wherever the range starts", () => {
    expect(
      hitsLabel({ path: "/a.pdf", page: 3 }, pdf(2, 3)),
      "a chunk covering pages 2 to 3 includes page 3: compare against the whole range, not just pageStart",
    ).toBe(true);
    expect(hitsLabel({ path: "/a.pdf", page: 2 }, pdf(1, 3))).toBe(true);
    expect(hitsLabel({ path: "/a.pdf", page: 4 }, pdf(1, 3))).toBe(false);
  });

  it("reads a chunk with no pageEnd as one page", () => {
    const single = { path: "/a.pdf", pageStart: 5, pageEnd: null };
    expect(hitsLabel({ path: "/a.pdf", page: 5 }, single), "pageEnd null means the chunk is page 5 alone").toBe(true);
    expect(hitsLabel({ path: "/a.pdf", page: 6 }, single)).toBe(false);
  });

  it("matches a pageless label with any chunk of its document, and a paged one never with a pageless chunk", () => {
    expect(hitsLabel({ path: "/b.md", page: null }, MD)).toBe(true);
    expect(hitsLabel({ path: "/b.md", page: null }, { ...pdf(7), path: "/b.md" })).toBe(true);
    expect(
      hitsLabel({ path: "/b.md", page: 1 }, MD),
      "a chunk with no pages can't include page 1: a pageless chunk never hits a paged label",
    ).toBe(false);
  });
});

describe("judge", () => {
  it("credits each label once, to the highest chunk that hits it", () => {
    const labels: Label[] = [
      { path: "/a.pdf", page: 2 },
      { path: "/b.md", page: null },
    ];
    expect(
      judge([pdf(9), pdf(2), pdf(2), MD, pdf(1, 2)], labels),
      "the second and third chunks of page 2 repeat a label already found: null",
    ).toEqual([null, 0, null, 1, null]);
  });

  it("lets a chunk spanning two labelled pages find the second when the first is taken", () => {
    const labels: Label[] = [
      { path: "/a.pdf", page: 2 },
      { path: "/a.pdf", page: 3 },
    ];
    expect(
      judge([pdf(2), pdf(2, 3)], labels),
      "pages 2 to 3 hit both labels; label 0 is found, so the chunk finds label 1. Skip found labels before choosing",
    ).toEqual([0, 1]);
  });

  it("gives one place per chunk, and nothing for an empty ranking", () => {
    expect(judge([pdf(9), pdf(8)], [{ path: "/a.pdf", page: 1 }])).toEqual([null, null]);
    expect(judge([], [{ path: "/a.pdf", page: 1 }])).toEqual([]);
  });
});

describe("the golden set's 14 October run", () => {
  const report = readGoldenReport();

  it("judges Daniel Reyes's Heron question as the report did: labels at ranks 2, 5 and 6", () => {
    const heron = report.questions.find((q) => q.id === "heron-cfo")!;
    expect(heron.user).toBe("daniel.reyes");
    expect(heron.labels.map((l) => [l.path, l.page])).toEqual([
      ["/Exec/Project Heron Board Memo.pdf", 1],
      ["/Exec/Project Heron Board Memo.pdf", 3],
      ["/Exec/Exec Offsite Notes Sept 2026.pdf", 1],
    ]);
    expect(
      judge(heron.ranked, heron.labels),
      "rank 4 is a Word file (no pages), rank 5 covers pages 1-2 of the notes, rank 10 repeats the memo's page 1",
    ).toEqual([null, 0, null, null, 2, 1, null, null, null, null]);
  });

  it("gives every question's ranking the label column the report recorded", () => {
    const answered = report.questions.filter((q) => q.labels.length > 0);
    expect(answered).toHaveLength(40);
    const wrong = answered
      .filter((q) => JSON.stringify(judge(q.ranked, q.labels)) !== JSON.stringify(q.ranked.map((c) => c.label)))
      .map((q) => q.id);
    expect(wrong, "these questions' chunks found different labels than the run recorded").toEqual([]);
  });
});
