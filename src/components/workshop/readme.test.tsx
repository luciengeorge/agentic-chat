import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Readme } from "./readme";

describe("Readme", () => {
  it("keeps this app's links in the tab, opens other sites in a new one, and leaves repo paths as text", () => {
    render(
      <Readme
        text={[
          "# Token-based sizing",
          "",
          "Open http://localhost:3000/labs/chunking, read [the tokenizer](https://github.com/niieani/gpt-tokenizer) and [PLAN.md](../PLAN.md).",
          "",
          "🐨 Open `playground/chunk.ts` and write **pack**.",
        ].join("\n")}
      />,
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Token-based sizing");
    expect(screen.getByRole("link", { name: "http://localhost:3000/labs/chunking" })).toHaveAttribute(
      "href",
      "/labs/chunking",
    );
    const outside = screen.getByRole("link", { name: "the tokenizer" });
    expect(outside).toHaveAttribute("target", "_blank");
    expect(screen.queryByRole("link", { name: "PLAN.md" })).toBeNull();
    expect(screen.getByText("PLAN.md")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Do this, one block of work at a time" })).toHaveTextContent("🐨");
    expect(screen.getByText("playground/chunk.ts").tagName).toBe("CODE");
  });
});
