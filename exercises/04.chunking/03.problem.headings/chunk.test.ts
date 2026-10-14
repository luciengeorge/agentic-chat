// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { Block, ParsedDocument } from "#learn/parse/types";

import { chunk } from "#learn/chunk/chunk";
import { parse, PDF } from "#learn/parse/parse";
import { corpusFile } from "@/core/parse/corpus.test-helpers";

const heading = (level: number, text: string): Block => ({ kind: "heading", level, text });
const rule = (topic: string, i: number) => `${topic} rule ${i} applies to every payout.`;
const rules = (topic: string, count: number) => Array.from({ length: count }, (_, i) => rule(topic, i + 1)).join(" ");
const text = (value: string): Block => ({ kind: "text", text: value });
const doc = (...blocks: Block[]): ParsedDocument => ({ mimeType: "text/markdown", pages: null, blocks });
const noOcr = {
  rasterise: () => Promise.reject(new Error("this page has a text layer")),
  ocr: () => Promise.reject(new Error("this page has a text layer")),
};

describe("structure-aware chunking", () => {
  it("starts a new chunk at a heading, even when the last chunk has room", () => {
    const chunks = chunk(
      doc(heading(2, "Pipeline"), text(rules("Pipeline", 2)), heading(2, "Rollback"), text(rules("Rollback", 1))),
    );
    expect(chunks.map((c) => c.text)).toEqual([
      `## Pipeline\n\n${rules("Pipeline", 2)}`,
      `## Rollback\n\n${rules("Rollback", 1)}`,
    ]);
  });

  it("opens one chunk for headings in a row, with the text under them", () => {
    const chunks = chunk(doc(heading(1, "Runbook"), heading(2, "Pipeline"), text(rules("Pipeline", 2))));
    expect(chunks.map((c) => [c.text, c.section])).toEqual([
      [`# Runbook\n\n## Pipeline\n\n${rules("Pipeline", 2)}`, "Pipeline"],
    ]);
  });

  it("gives the text before the first heading a chunk of its own, with no section", () => {
    const chunks = chunk(doc(text(rules("Intro", 2)), heading(2, "Scope"), text(rules("Scope", 1))));
    expect(chunks.map((c) => [c.text, c.section])).toEqual([
      [rules("Intro", 2), null],
      [`## Scope\n\n${rules("Scope", 1)}`, "Scope"],
    ]);
  });

  it("never mixes two sections in a chunk or carries overlap across a heading", () => {
    const topics = ["Refunds", "Chargebacks", "Payouts"];
    const chunks = chunk(doc(...topics.flatMap((topic) => [heading(2, topic), text(rules(topic, 20))])), {
      targetTokens: 100,
      overlapTokens: 30,
    });
    expect(chunks.length).toBeGreaterThan(6);
    for (const c of chunks) {
      const held = [...c.text.matchAll(/(\w+) rule \d+/g)].map((match) => match[1]);
      expect(new Set(held), `chunk ${c.ordinal}`).toEqual(new Set([c.section]));
    }
    for (const topic of topics) {
      const first = chunks.find((c) => c.section === topic)!;
      expect(first.text.startsWith(`## ${topic}\n\n${rule(topic, 1)}`), `${topic} starts clean`).toBe(true);
    }
  });

  it("cuts page 2 of the Ashgrove MSA into one chunk per clause", async () => {
    const msa = corpusFile("legal-contract-kpc-2026-0142-ashgrove-msa");
    const page2 = await parse(msa.bytes(), PDF, noOcr, { pages: { from: 2, to: 2 } });
    const chunks = chunk(page2);
    expect(chunks.map((c) => c.section)).toEqual([
      null,
      "6. Security",
      "7. Data protection",
      "8. Audit and regulator access",
      "9. Liability",
      "10. Termination",
      "11. Exit",
      "12. Subcontracting",
      "13. Disputes and notices",
      "14. Governing law",
    ]);
    expect(chunks.find((c) => c.section === "9. Liability")!.tokenCount).toBe(66);
  });
});
