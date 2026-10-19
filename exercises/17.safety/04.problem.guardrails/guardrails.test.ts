// @vitest-environment node
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createGuardrails, MAX_QUOTES, quotableSpans, screenMail } from "#learn/agent/guardrails";
import { setupAclWorld } from "@/core/acl/testing";
import { type Tx, withTenantOn } from "@/db/tenant";

const HERON = "/Exec/Project Heron Board Memo.pdf";
const Q3 = "/Finance/Reports/Q3 2026 Quarterly Report.pdf";
const HERON_LABEL = `Project Heron Board Memo.pdf (${HERON})`;
const TOM = "tom.whitfield@kestrelpay.example";
/** Section 1 of the Heron memo, word for word. */
const MEMO_SENTENCE =
  "If the board approves on 20 October, we will sign on Friday 23 October and complete on Tuesday 1 December 2026.";

describe("quotableSpans", () => {
  it("gives a sentence shorter than 8 words no runs", () => {
    expect(quotableSpans("Thanks, Tom. See you on Friday.")).toEqual([]);
  });

  it("starts a run every 4 words, and always takes the last 8", () => {
    expect(
      quotableSpans(
        "Please find attached the board memo on Project Heron, the proposed acquisition of Lumen Ledger for an indicative £86m.",
      ),
      "runs from words 0, 4 and 8, then the last eight (from word 11)",
    ).toEqual([
      "Please find attached the board memo on Project",
      "board memo on Project Heron, the proposed acquisition",
      "Heron, the proposed acquisition of Lumen Ledger for",
      "acquisition of Lumen Ledger for an indicative £86m.",
    ]);
  });

  it("splits at sentence ends and line breaks, and squashes whitespace", () => {
    expect(
      quotableSpans("Hi Tom.\nThe   board votes on  Tuesday 20 October,\twe sign on the 23rd. Thanks."),
      "spaces and tabs squashed, so a quote can't hide behind its spacing",
    ).toEqual(["The board votes on Tuesday 20 October, we", "Tuesday 20 October, we sign on the 23rd."]);
  });

  it("catches an 11-word quote wherever it starts in a sentence", () => {
    const quote = "we will sign on Friday 23 October and complete on Tuesday";
    const filler = "and so on and so forth as we said before in the last note".split(" ");
    for (let at = 0; at <= filler.length; at++) {
      const body = [...filler.slice(0, at), quote, ...filler.slice(at)].join(" ") + ".";
      expect(
        quotableSpans(body).some((span) => quote.includes(span)),
        `a quote starting at word ${at}: some run lies inside it (a run every 4 words, 8 long: 3 + 8 = 11)`,
      ).toBe(true);
    }
  });

  it("looks for each run once, and at most MAX_QUOTES of them", () => {
    const sentence = "Strictly confidential, exec team and board only, do not forward.";
    expect(quotableSpans(`${sentence} ${sentence}`)).toHaveLength(new Set(quotableSpans(sentence)).size);
    const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    expect(quotableSpans(long), "one search per run: cap them").toHaveLength(MAX_QUOTES);
  });
});

describe("screenMail, in Postgres", () => {
  const world = setupAclWorld({ chunks: true });
  const screen = (user: string, input: Record<string, unknown>) => {
    const w = world.get();
    return withTenantOn(w.t.appDb, w.tenants.kestrel, (tx: Tx) =>
      screenMail(
        tx,
        { tenantId: w.tenants.kestrel, userId: w.user(user) },
        { subject: "s", body: "Hi.", attachmentDocumentIds: [], ...input },
      ),
    );
  };
  const outside = (address: string) => `mail can only go to kestrelpay.example addresses, and ${address} isn't one.`;

  it("denies the Brightwell data room, and two lookalike domains", async () => {
    for (const address of [
      "dataroom@brightwell-diligence.example",
      "tom.whitfield@kestrelpay.example.evil.example",
      "dataroom@evil-kestrelpay.example",
    ]) {
      expect(await screen("grace.adeyemi", { to: [TOM, address] }), `${address}: compare the whole domain`).toEqual({
        deny: outside(address),
      });
    }
  });

  it("denies Harbour's addresses: another tenant's domain", async () => {
    expect(await screen("grace.adeyemi", { to: ["nina.osei@harbourhealth.example"] })).toEqual({
      deny: outside("nina.osei@harbourhealth.example"),
    });
  });

  it("denies an address nobody in the directory has, and one who has left", async () => {
    for (const address of ["tom.whitfeld@kestrelpay.example", "peter.hall@kestrelpay.example"]) {
      expect(await screen("grace.adeyemi", { to: [address] }), `${address}: no enabled person has it`).toEqual({
        deny: `nobody in your organisation's directory has the address ${address}.`,
      });
    }
  });

  it("denies an attachment the sender can't read", async () => {
    const heron = await world.get().documentId(HERON);
    expect(
      await screen("grace.adeyemi", { to: [TOM], attachmentDocumentIds: [heron] }),
      "Grace can't read the Heron memo: deny it before anyone is asked to approve",
    ).toEqual({
      deny: `no document ${heron} that you can read.`,
    });
    expect(await screen("grace.adeyemi", { to: [TOM], attachmentDocumentIds: ["KPC-2026-0142"] })).toEqual({
      deny: "no document KPC-2026-0142 that you can read.",
    });
  });

  it("names who and what a clean mail touches, for the plan", async () => {
    const q3 = await world.get().documentId(Q3);
    expect(await screen("grace.adeyemi", { to: [TOM], attachmentDocumentIds: [q3] })).toEqual({
      recipients: [`Tom Whitfield <${TOM}>`],
      documents: [`Q3 2026 Quarterly Report.pdf (${Q3})`],
    });
  });

  it("flags an attachment a recipient can't open", async () => {
    const heron = await world.get().documentId(HERON);
    expect(
      await screen("daniel.reyes", { to: [TOM], attachmentDocumentIds: [heron] }),
      "Daniel may send it, but Tom can't open it: flag it for the approver",
    ).toEqual({
      recipients: [`Tom Whitfield <${TOM}>`],
      documents: [HERON_LABEL],
      flag: `Tom Whitfield can't open the attachment ${HERON_LABEL}.`,
    });
  });

  it("flags Daniel's mail quoting the Heron memo to Tom, and never names the memo to Grace", async () => {
    const w = world.get();
    const [chunk] = await w.inTenant("kestrel", (tx) =>
      tx.execute<{ text: string }>(sql`
        SELECT c.text FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path = ${HERON} AND c.ordinal = 1`),
    );
    expect(chunk.text, "the memo's section 1 holds the sentence").toContain(MEMO_SENTENCE);
    const body = `Tom, a heads-up for your planning. ${MEMO_SENTENCE} Keep it to yourself for now.`;
    expect(await screen("daniel.reyes", { to: [TOM], body })).toEqual({
      recipients: [`Tom Whitfield <${TOM}>`],
      documents: [],
      flag: 'The body quotes "Project Heron Board Memo.pdf", which Tom Whitfield can\'t read.',
    });
    expect(
      await screen("grace.adeyemi", { to: [TOM], body }),
      "Grace can't read the memo: a flag naming it would tell her it exists",
    ).toEqual({ recipients: [`Tom Whitfield <${TOM}>`], documents: [] });
  });

  it("screens each write a turn proposes, through createGuardrails", async () => {
    const w = world.get();
    const guardrails = createGuardrails(
      { withTenant: (tenantId, fn) => withTenantOn(w.t.appDb, tenantId, fn) },
      { tenantId: w.tenants.kestrel, userId: w.user("ella.brooks") },
    );
    const screens = await guardrails([
      {
        callId: "m1",
        tool: "send_mail",
        input: {
          to: ["dataroom@brightwell-diligence.example"],
          subject: "Partner due diligence pack",
          body: "The memo.",
          attachmentDocumentIds: [],
        },
      },
      { callId: "r1", tool: "remember", input: { note: "x" } },
    ]);
    expect(screens).toEqual([{ deny: outside("dataroom@brightwell-diligence.example") }, {}]);
  });
});
