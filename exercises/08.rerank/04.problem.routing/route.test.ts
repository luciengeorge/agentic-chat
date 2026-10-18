import { describe, expect, it } from "vitest";

import { type DocumentCard, routeDocuments } from "#learn/query/route";
import { MERCHANT_EXIT_CARDS } from "@/core/query/recorded";

const card = (documentId: string, text: string, embedding: number[] | null, title = documentId): DocumentCard => ({
  documentId,
  title,
  path: `/Docs/${title}`,
  text,
  embedding,
});

describe("routeDocuments", () => {
  it("adds up the two rankings with RRF, instead of trusting either one", () => {
    // BM25 ranks B then C (A has none of the words); the vectors rank C, then A, then B.
    const cards = [
      card("A", "Receipts and approvals.", [0.7, 0.7]),
      card("B", "Hotel limit in London: £200.", [0, 1]),
      card("C", "Hotel bookings.", [1, 0]),
    ];
    expect(
      routeDocuments("hotel limit London", [1, 0], cards, 3),
      "C is 1st and 2nd, B 1st and 3rd: 1/61 + 1/62 beats 1/61 + 1/63. Sum RRF shares over both lists",
    ).toEqual(["C", "B", "A"]);
  });

  it("puts the nearest vector first: the highest cosine similarity, not the lowest", () => {
    const cards = [card("near", "x", [1, 0.1]), card("far", "y", [-1, 0.2]), card("middle", "z", [0.5, 0.5])];
    expect(routeDocuments("nothing in common", [1, 0], cards, 3)).toEqual(["near", "middle", "far"]);
  });

  it("matches a card's title and path as well as its first chunk", () => {
    const cards = [
      card("register", "Each agreement, by number.", null, "Contract Register 2026.pdf"),
      card("menu", "Soup and sandwiches.", null, "Lunch Menu.md"),
    ];
    expect(
      routeDocuments("contract register", [1, 0], cards, 1),
      "BM25 should read `${title}\\n${path}\\n${text}`: the words here are only in the title",
    ).toEqual(["register"]);
  });

  it("still routes a card with no vector for the query's model, by its words alone", () => {
    const cards = [card("register", "Contracts by number.", null), card("menu", "Soup.", [1, 0])];
    expect(routeDocuments("contracts by number", [1, 0], cards, 2), "skip a null vector, keep the card").toEqual([
      "register",
      "menu",
    ]);
  });

  it("returns at most `limit` documents, and refuses a limit that isn't a whole number from 1", () => {
    const cards = ["a", "b", "c"].map((id) => card(id, `${id} text`, [1, 0]));
    expect(routeDocuments("text", [1, 0], cards, 2)).toHaveLength(2);
    expect(routeDocuments("text", [1, 0], cards, 10)).toHaveLength(3);
    for (const limit of [0, -1, 1.5]) {
      expect(() => routeDocuments("text", [1, 0], cards, limit), `limit ${limit}`).toThrow(RangeError);
    }
  });

  it("sends Sofia's merchant M-221449 question to 5 documents, and the filing that answers isn't one", () => {
    const { question, questionEmbedding, cards } = MERCHANT_EXIT_CARDS;
    expect(cards).toHaveLength(15);
    const title = (id: string) => cards.find((c) => c.documentId === id)!.title;
    const routed = routeDocuments(question, questionEmbedding, cards, 5).map(title);
    expect(routed).toEqual([
      "Delegated Authority Matrix 2026.pdf",
      "Contract Register 2026-09-28.pdf",
      "Compliance Monitoring Report Q2 2026.pdf",
      "KPC-2026-0142 Ashgrove MSA (executed).pdf",
      "Leave Policy.pdf",
    ]);

    const filing = cards.find((c) => c.title === "FCA Annual Regulatory Return 2026.pdf")!;
    expect(filing.text.startsWith("# Annual Regulatory Return 2026")).toBe(true);
    expect(filing.text).not.toContain("M-221449");
    expect(routeDocuments(question, questionEmbedding, cards, 15).map(title).indexOf(filing.title) + 1).toBe(8);
  });
});
