import { describe, expect, it } from "vitest";

import { checkAnswer, checkGates, mentions, type GateOracle } from "./checks";

const labels = [{ path: "/HR/Policies/v2.pdf", page: 2 }];

describe("checkAnswer", () => {
  it("passes an answer that cites a labelled document", () => {
    const outcome = { text: "£40", abstained: false, citedPaths: ["/HR/Policies/v1.pdf", "/HR/Policies/v2.pdf"] };
    expect(checkAnswer("answer", labels, outcome)).toEqual({ passed: true, reasons: [] });
  });

  it("fails an answer that cites only other documents, cites nothing, or abstains", () => {
    expect(
      checkAnswer("answer", labels, { text: "£35", abstained: false, citedPaths: ["/HR/Policies/v1.pdf"] }),
    ).toEqual({ passed: false, reasons: ["cited no labelled document (cited /HR/Policies/v1.pdf)"] });
    expect(checkAnswer("answer", labels, { text: "£40", abstained: false, citedPaths: [] }).reasons).toEqual([
      "cited nothing",
    ]);
    expect(checkAnswer("answer", labels, { text: "no", abstained: true, citedPaths: [] }).reasons).toEqual([
      "abstained",
      "cited nothing",
    ]);
  });

  it("passes an abstain case only when it abstained", () => {
    expect(checkAnswer("abstain", [], { text: "", abstained: true, citedPaths: [] }).passed).toBe(true);
    expect(checkAnswer("abstain", [], { text: "x", abstained: false, citedPaths: [] })).toEqual({
      passed: false,
      reasons: ["answered instead of abstaining"],
    });
  });
});

describe("mentions", () => {
  it("finds needles ignoring case and whitespace", () => {
    expect(mentions("The price is  £86M.\nLumen\nLedger", ["£86m", "lumen ledger", "Tamar"])).toEqual([
      "£86m",
      "lumen ledger",
    ]);
  });
});

describe("checkGates", () => {
  const oracle: GateOracle = {
    tenantOf: (id) => ({ d1: "kestrel", d2: "kestrel", d3: "harbour" })[id],
    canRead: (path) => path === "/ok.pdf",
  };

  it("passes readable chunks and citations in the viewer's tenant", () => {
    const result = checkGates(
      {
        tenantId: "kestrel",
        retrieved: [{ documentId: "d1", path: "/ok.pdf" }],
        citedPaths: ["/ok.pdf"],
        text: "fine",
        secrets: ["£86m"],
      },
      oracle,
    );
    expect(result).toEqual({ leaks: [], crossTenant: [] });
  });

  it("reports unreadable chunks and citations, secrets in the answer, and other tenants' or unknown documents", () => {
    const result = checkGates(
      {
        tenantId: "kestrel",
        retrieved: [
          { documentId: "d2", path: "/Exec/memo.pdf" },
          { documentId: "d3", path: "/Policies/x.pdf" },
          { documentId: "d9", path: "/gone.pdf" },
        ],
        citedPaths: ["/Exec/memo.pdf"],
        text: "It costs £86m.",
        secrets: ["£86m", "Lumen"],
      },
      oracle,
    );
    expect(result).toEqual({
      leaks: ["retrieved /Exec/memo.pdf", "cited /Exec/memo.pdf", 'said "£86m"'],
      crossTenant: ["/Policies/x.pdf", "/gone.pdf"],
    });
  });

  it("checks no text in a retrieval-only run", () => {
    expect(
      checkGates({ tenantId: "kestrel", retrieved: [], citedPaths: [], text: null, secrets: ["x"] }, oracle),
    ).toEqual({ leaks: [], crossTenant: [] });
  });
});
