import { describe, expect, it } from "vitest";

import { parseHints } from "./hints";

describe("parseHints", () => {
  it("reads each hint with its indented lines, in file order, and stops at a blank comment or code", () => {
    const source = [
      "// 👨‍💼 Kestrel can't search a filing as one piece.",
      "//    So ingestion cuts it.",
      "",
      "export function pack() {",
      "  // 🐨 Walk the units in order.",
      "  //    Keep a running total.",
      "  //",
      "  //    not part of any hint",
      "  // 💰 `current.length > 0` says whether a window holds anything.",
      "  // a plain comment",
      "  const x = 1; // 🦉 not at the start of a line, so not a hint",
      "  // 📜 https://github.com/niieani/gpt-tokenizer",
      "  throw new Error();",
      "}",
    ].join("\n");
    expect(parseHints("chunk.ts", source)).toEqual([
      {
        emoji: "👨‍💼",
        text: "Kestrel can't search a filing as one piece. So ingestion cuts it.",
        file: "chunk.ts",
        line: 1,
      },
      { emoji: "🐨", text: "Walk the units in order. Keep a running total.", file: "chunk.ts", line: 5 },
      {
        emoji: "💰",
        text: "`current.length > 0` says whether a window holds anything.",
        file: "chunk.ts",
        line: 9,
      },
      { emoji: "📜", text: "https://github.com/niieani/gpt-tokenizer", file: "chunk.ts", line: 12 },
    ]);
  });
});
