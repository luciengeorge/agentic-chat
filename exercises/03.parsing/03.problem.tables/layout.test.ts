// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { Block } from "#learn/parse/types";

import { layoutPage, type PositionedText } from "#learn/parse/layout";
import { parse, PDF } from "#learn/parse/parse";
import { corpusFile } from "@/core/parse/corpus.test-helpers";

const A4 = 842;
/** A run of 9pt table text; `width` is where it ends, as pdf.js measures it. */
const cell = (str: string, x: number, y: number, width: number): PositionedText => ({ str, x, y, width, fontSize: 9 });
const noOcr = {
  rasterise: () => Promise.reject(new Error("this page has a text layer")),
  ocr: () => Promise.reject(new Error("this page has a text layer")),
};
const table = (blocks: Block[]) => {
  const found = blocks.find((block) => block.kind === "table");
  if (!found || found.kind !== "table") throw new Error("no table found");
  return found;
};
const md = (...rows: string[][]) =>
  [rows[0], rows[0].map(() => "---"), ...rows.slice(1)].map((row) => `| ${row.join(" | ")} |`).join("\n");

// The error code table's header, at the x positions the catalogue uses: columns at 66.7, 109.7, 141.2, 251.8, 333.4.
const header = (y: number) => [
  cell("Code", 66.7, y, 22.5),
  cell("HTTP", 109.7, y, 23.5),
  cell("Meaning", 141.2, y, 36.5),
  cell("Retry", 251.8, y, 23),
  cell("What the merchant should do", 333.4, y, 126.5),
];

describe("tables", () => {
  it("keeps a wrapped line in its row and its column, even when it only fills the last column", () => {
    const items = [
      ...header(246.9),
      cell("KP-1002", 66.7, 231.1, 35),
      cell("401", 109.7, 231.1, 15),
      cell("API key revoked", 141.2, 231.1, 65.6),
      cell("No", 251.8, 231.1, 11.5),
      cell("Create a new key in Dashboard,", 333.4, 231.1, 196),
      // 11.2 points down: the same row. Its only segment starts at 333.4, under the last column.
      cell("then revoke the old one.", 333.4, 219.9, 101),
    ];
    const found = table(layoutPage(items, A4));
    expect(
      found.markdown,
      "a wrapped line holds only the cells that wrapped: find columns across all lines, and rows by the gap above",
    ).toBe(
      md(
        ["Code", "HTTP", "Meaning", "Retry", "What the merchant should do"],
        ["KP-1002", "401", "API key revoked", "No", "Create a new key in Dashboard, then revoke the old one."],
      ),
    );
    expect(found.rows).toBe(1);
  });

  it("keeps an empty cell in its place", () => {
    const items = [
      ...header(246.9),
      cell("KP-1009", 66.7, 231.1, 35),
      cell("429", 109.7, 231.1, 15),
      cell("Rate limit exceeded", 141.2, 231.1, 79),
      // No Retry cell on this line.
      cell("Back off and retry.", 333.4, 231.1, 80),
    ];
    expect(
      table(layoutPage(items, A4)).markdown,
      'a missing cell is "", and the cells after it keep their column',
    ).toBe(
      md(
        ["Code", "HTTP", "Meaning", "Retry", "What the merchant should do"],
        ["KP-1009", "429", "Rate limit exceeded", "", "Back off and retry."],
      ),
    );
  });

  it("puts right-aligned numbers in their column, though no two start at the same x", () => {
    // Amounts end at 300, so they start at 255 and 268, not at the header's 245.
    const items = [
      cell("Contract no.", 67, 745, 55),
      cell("Owner", 139, 745, 30),
      cell("Annual value", 245, 745, 55),
      cell("KPC-2021-0034", 67, 728, 64),
      cell("Tom Whitfield", 139, 728, 55),
      cell("£6,200,000", 255, 728, 45),
      cell("KPC-2022-0019", 67, 711, 64),
      cell("Emily Tran", 139, 711, 45),
      cell("£95,000", 268, 711, 32),
    ];
    expect(
      table(layoutPage(items, A4)).markdown,
      "match a segment to the column whose x range holds its start, not to a column that starts at the same x",
    ).toBe(
      md(
        ["Contract no.", "Owner", "Annual value"],
        ["KPC-2021-0034", "Tom Whitfield", "£6,200,000"],
        ["KPC-2022-0019", "Emily Tran", "£95,000"],
      ),
    );
  });

  it("starts a row only where the gap is wider than a wrapped line's: 16 points is a new row, 11 isn't", () => {
    const items = [
      cell("Rule", 67, 745, 20),
      cell("Limit", 139, 745, 25),
      cell("Meals", 67, 729, 25),
      cell("£40 a head,", 139, 729, 50),
      cell("receipts above £25", 139, 718, 80),
      cell("London hotels", 67, 702, 60),
      cell("£200 a night", 139, 702, 55),
    ];
    const found = table(layoutPage(items, A4));
    expect(found.rows, "lines 11 points apart are one row; 16 apart start a new one (the cut is 1.4 x 9pt)").toBe(2);
    expect(found.markdown).toBe(
      md(["Rule", "Limit"], ["Meals", "£40 a head, receipts above £25"], ["London hotels", "£200 a night"]),
    );
  });

  it("rebuilds the error code table on page 1 of the catalogue: 14 lines, five codes, five rows", async () => {
    const catalogue = corpusFile("eng-payments-api-error-codes");
    const page1 = await parse(catalogue.bytes(), PDF, noOcr, { pages: { from: 1, to: 1 } });
    const codes = page1.blocks.find((block) => block.kind === "table" && block.markdown.startsWith("| Code | HTTP"));
    expect(codes, "no table starting | Code | HTTP | on page 1").toBeDefined();
    expect(codes).toEqual({
      kind: "table",
      rows: 5,
      markdown: md(
        ["Code", "HTTP", "Meaning", "Retry", "What the merchant should do"],
        [
          "KP-1001",
          "401",
          "API key missing or not recognised",
          "No",
          "Send a live key (kp_live_) in live mode or a test key (kp_test_) in the sandbox, in the Authorization header.",
        ],
        [
          "KP-1002",
          "401",
          "API key revoked",
          "No",
          "Create a new key in Dashboard, Developers, API keys. Old keys are revoked 7 days after a rotation.",
        ],
        [
          "KP-1003",
          "403",
          "Key lacks the scope for this endpoint",
          "No",
          "Add the scope (for example payouts:write) to the key, or use a key that has it.",
        ],
        [
          "KP-1004",
          "403",
          "Request came from an IP address not on the allowlist",
          "No",
          "Add the address in Dashboard, Developers, IP allowlist. Changes take up to 5 minutes.",
        ],
        [
          "KP-1009",
          "429",
          "Rate limit exceeded",
          "Yes, after Retry-After",
          "Back off and retry. Default limits are 100 requests a second per merchant, and 25 a second for Payouts endpoints.",
        ],
      ),
    });
  });
});
