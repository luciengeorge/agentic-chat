// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { Fetch, SmokeTargets } from "./smoke";

import { DEFAULT_CORPUS_DIR } from "../../servers/fake-workspace/app";
import { checkAnswer, parseChatStream } from "./smoke-answer";
import { refused } from "./test-repo";

const APP_URL = "http://localhost:3000";
const V2 = "/HR/Policies/Travel and Expenses Policy v2.pdf";
const ABSTAIN = "I couldn't find an answer to that in the documents you can access.";

const sse = (parts: unknown[]) =>
  [...parts.map((part) => `data: ${JSON.stringify(part)}\n\n`), ": heartbeat\n\n", "data: [DONE]\n\n"].join("");

const source = (path: string) => ({
  label: "S1",
  chunkId: "c",
  documentId: "d",
  title: "t",
  path,
  pageStart: 2,
  pageEnd: 2,
});
const citation = (path: string) => ({
  marker: "[[S1]]",
  label: "S1",
  quote: "q",
  chunkId: "c",
  documentId: "d",
  title: "t",
  path,
  page: 2,
});

function reply(text: string, sources: string[], verdict: { citations?: string[]; abstained?: boolean }) {
  return sse([
    { type: "start", messageId: "m" },
    { type: "data-sources", id: "sources", data: { sources: sources.map(source) } },
    { type: "text-start", id: "text" },
    { type: "text-delta", id: "text", delta: text },
    { type: "text-end", id: "text" },
    {
      type: "data-verdict",
      id: "verdict",
      data: {
        citations: (verdict.citations ?? []).map(citation),
        dropped: [],
        abstained: !!verdict.abstained,
        flagged: false,
      },
    },
    { type: "finish", finishReason: "stop" },
  ]);
}

/** The two routes the check calls; `answers` maps a question's first word to the stream it gets. */
function app(answers: { meals: string; heron: string }): Fetch & { requests: string[] } {
  const requests: string[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const { pathname } = new URL(url);
    requests.push(pathname);
    if (pathname === "/api/auth/sign-in/email") {
      return new Response("{}", { headers: { "set-cookie": "session=abc; Path=/; HttpOnly" } });
    }
    if (pathname === "/api/auth/sign-out") return new Response("{}");
    if (pathname !== "/api/chat") return new Response("Not Found", { status: 404 });
    if (new Headers(init?.headers).get("cookie") !== "session=abc") return new Response("{}", { status: 401 });
    const { message } = JSON.parse(String(init?.body)) as { message: { parts: { text: string }[] } };
    const body = message.parts[0].text.includes("Heron") ? answers.heron : answers.meals;
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };
  return Object.assign(fetch, { requests });
}

const targets = (fetch: Fetch): SmokeTargets => ({
  databaseUrl: "",
  appUrl: APP_URL,
  workspaceUrl: "",
  corpusDir: DEFAULT_CORPUS_DIR,
  fetch,
});

const good = {
  meals: reply('£40 a day [[S1: "Meals and subsistence"]]', [V2], { citations: [V2] }),
  heron: reply(ABSTAIN, ["/Company/Brightwell Payroll Partner Onboarding Pack v1.3.docx"], { abstained: true }),
};

describe("parseChatStream", () => {
  it("collects text, sources and the verdict, skipping heartbeats", () => {
    const parsed = parseChatStream(good.meals);
    expect(parsed.text).toBe('£40 a day [[S1: "Meals and subsistence"]]');
    expect(parsed.sources.map((s) => s.path)).toEqual([V2]);
    expect(parsed.verdict?.citations.map((c) => c.path)).toEqual([V2]);
    expect(parsed.errors).toEqual([]);
  });
});

describe("checkAnswer", () => {
  it("passes a cited answer and an abstention, then signs out", async () => {
    const fetch = app(good);
    expect(await checkAnswer(targets(fetch))).toBe(
      `leo.martin: "expenses-meals" cited ${V2} p2 (1 citations, 0 dropped); "heron-intern" abstained from 1 sources, none in /Exec`,
    );
    expect(fetch.requests.at(-1)).toBe("/api/auth/sign-out");
  });

  it("fails an answer that cites the old policy only", async () => {
    const v1 = "/HR/Policies/Travel and Expenses Policy.pdf";
    const fetch = app({ ...good, meals: reply("£35", [v1], { citations: [v1] }) });
    await expect(checkAnswer(targets(fetch))).rejects.toThrow(`expenses-meals: no citation of ${V2} (cited ${v1})`);
  });

  it("passes a Heron reply that hedges without leaking", async () => {
    const hedge = reply("The documents mention a Heron memo but not what it is.", [], { citations: [] });
    expect(await checkAnswer(targets(app({ ...good, heron: hedge })))).toContain(
      '"heron-intern" hedged from 0 sources',
    );
  });

  it("fails when the Heron answer leaks, or an /Exec source reaches the intern", async () => {
    await expect(
      checkAnswer(targets(app({ ...good, heron: reply("It is Lumen Ledger.", [], { citations: [] }) }))),
    ).rejects.toThrow("heron-intern: the reply says Lumen Ledger");
    await expect(
      checkAnswer(
        targets(app({ ...good, heron: reply(ABSTAIN, ["/Exec/Project Heron Board Memo.pdf"], { abstained: true }) })),
      ),
    ).rejects.toThrow("heron-intern: sources include /Exec/Project Heron Board Memo.pdf");
  });

  it("says when the app isn't running", async () => {
    await expect(checkAnswer(targets(refused))).rejects.toThrow("is `pnpm dev` running?");
  });
});
