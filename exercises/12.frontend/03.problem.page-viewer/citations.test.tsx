import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Citation } from "#learn/cite/citations";
import type { ChatUIMessage, SourceRef, StoredUIMessage } from "@/components/chat/types";

import { ChatView } from "@/components/chat/chat-view";
import { AssistantMessage } from "@/components/chat/messages";
import { mealAllowance } from "@/core/frontend/recorded";
import { fakeFetch, renderInApp } from "@/core/frontend/testing";
import { getCitedChunk } from "@/routes/chat/-functions";

vi.mock("@/routes/chat/-functions", () => ({
  getConversation: vi.fn(),
  getConversationRuns: vi.fn(),
  getConversations: vi.fn(),
  getCitedChunk: vi.fn(),
  ensureConversation: vi.fn(),
}));

const { conversationId, conversation, citedChunks } = mealAllowance;

const V2 = "d60a5e6b-7614-4c46-94d6-0bbb4de2477f";
const NOTES = "7f3c1e20-0000-4000-8000-00000000000a";
const source = (label: string, title: string, page: number | null, documentId = V2): SourceRef => ({
  label,
  chunkId: `00000000-0000-4000-8000-0000000000${label.slice(1).padStart(2, "0")}`,
  documentId,
  title,
  path: `/HR/${title}`,
  pageStart: page,
  pageEnd: page,
});
const SOURCES = [
  source("S1", "Expenses FAQ.pdf", 3),
  source("S2", "Office notes.md", null, NOTES),
  source("S3", "Travel and Expenses Policy v2.pdf", 2),
];
const marker = (label: string, quote: string) => `[[${label}: "${quote}"]]`;
const kept = (label: string, quote: string): Citation => {
  const s = SOURCES.find((x) => x.label === label)!;
  return {
    marker: marker(label, quote),
    label,
    quote,
    chunkId: s.chunkId,
    documentId: s.documentId,
    title: s.title,
    path: s.path,
    page: s.pageStart,
  };
};

const reply = (text: string, citations: Citation[] | null, dropped: string[] = []): ChatUIMessage => ({
  id: "r1",
  role: "assistant",
  parts: [
    { type: "data-sources", id: "sources", data: { sources: SOURCES } },
    { type: "text", text, state: citations ? "done" : "streaming" },
    ...(citations
      ? [
          {
            type: "data-verdict" as const,
            id: "verdict",
            data: {
              citations,
              dropped: dropped.map((m) => ({ marker: m, label: null, reason: "quote-not-found" as const })),
              abstained: false,
              flagged: dropped.length > 0,
            },
          },
        ]
      : []),
  ],
});

const chips = () =>
  screen
    .queryAllByRole("button", { name: /^Source \d+:/ })
    .map((chip) => `${chip.textContent} ${chip.getAttribute("aria-label")!.replace(/^Source \d+: /, "")}`);

async function showReply(message: ChatUIMessage, streaming = false) {
  return renderInApp(() => <AssistantMessage message={message} streaming={streaming} onOpenSource={() => {}} />);
}

async function openStored(messages: StoredUIMessage[]) {
  return renderInApp(() => <ChatView id={conversationId} initialMessages={messages} />);
}

/** What follows the document's id in a link: "#page=3", or "" for none. */
const after = (href: string | null, documentId: string) => {
  expect(href, "the link doesn't point at /api/chat/documents/<documentId>").toMatch(
    new RegExp(`^/api/chat/documents/${documentId}`),
  );
  return href!.slice(`/api/chat/documents/${documentId}`.length);
};

const sheetLink = async () => {
  const sheet = await screen.findByRole("dialog").catch((error) => {
    const failed = document.querySelector("[data-render-error]");
    throw failed ? new Error(`the page failed to draw: ${failed.textContent}`) : error;
  });
  const link = await within(sheet)
    .findByRole("link", { name: /Open the document/ })
    .catch(() => null);
  expect(link, "the source panel opened, but has no link to the document").not.toBeNull();
  return { sheet, link: link! };
};

beforeEach(() => {
  vi.mocked(getCitedChunk).mockReset();
  vi.mocked(getCitedChunk).mockImplementation((async ({ data }: { data: { chunkId: string } }) => {
    return (
      citedChunks[data.chunkId] ?? {
        chunkId: data.chunkId,
        text: "Receipts are needed for any claim over £25.",
        section: null,
        pageStart: 3,
        pageEnd: 3,
        document: { id: V2, title: "Expenses FAQ.pdf", path: "/HR/Expenses FAQ.pdf", mimeType: "application/pdf" },
      }
    );
  }) as never);
  fakeFetch({});
});

describe("the chips", () => {
  it("number sources in the order the answer first cites them, one number per source", async () => {
    const text = `Hotels ${marker("S3", "Hotel, London | £200")}. Receipts ${marker("S1", "any claim over £25")}. And ${marker("S3", "rest of the UK | £130")}.`;
    await showReply(
      reply(text, [
        kept("S3", "Hotel, London | £200"),
        kept("S1", "any claim over £25"),
        kept("S3", "rest of the UK | £130"),
      ]),
    );
    expect(
      chips(),
      "S3 is cited first, so it's 1, S1 is 2, and S3's second quote is 1 again: numbers go by source, in order " +
        "of first appearance, not by the label's own number or by marker",
    ).toEqual([
      "1 Travel and Expenses Policy v2.pdf, page 2",
      "2 Expenses FAQ.pdf, page 3",
      "1 Travel and Expenses Policy v2.pdf, page 2",
    ]);
  });

  it("show nothing for a citation the validator dropped, and leave it out of the sources", async () => {
    const bad = marker("S1", "claims over £10 are fine");
    const text = `Receipts ${bad}. Hotels ${marker("S3", "Hotel, London | £200")}.`;
    await showReply(reply(text, [kept("S3", "Hotel, London | £200")], [bad]));
    expect(
      chips().map((chip) => chip.replace(/^\d+ /, "")),
      "the dropped S1 marker still shows a chip: once the verdict is in, only the citations it kept show",
    ).toEqual(["Travel and Expenses Policy v2.pdf, page 2"]);
    expect(chips()[0], "a marker that shows nothing takes no number, so the first chip shown is 1").toMatch(/^1 /);
    expect(screen.queryByText(/claims over £10/)).toBeNull();
    const list = within(screen.getByRole("list"));
    expect(list.getAllByRole("button").map((b) => b.textContent)).toEqual(["1Travel and Expenses Policy v2.pdfp. 2"]);
  });

  it("show as pending while the answer streams, and not at all for a label that names no source", async () => {
    const text = `Hotels ${marker("S3", "Hotel, London | £200")}. Taxis ${marker("S9", "taxis are fine")}. More`;
    await showReply(reply(text, null), true);
    const pending = screen.queryAllByRole("button", { name: /^Source \d+:/ });
    expect(
      pending.map((chip) => chip.getAttribute("aria-label")),
      "before the verdict, a marker whose label names a source shows as a pending chip (S3); one naming no source " +
        "(S9) shows nothing",
    ).toEqual(["Source 1: Travel and Expenses Policy v2.pdf, page 2"]);
    expect(pending[0], "a pending chip can't be clicked yet").toBeDisabled();
  });
});

describe("opening a source", () => {
  it("opens the cited document at its page", async () => {
    const text = `Receipts ${marker("S1", "any claim over £25")}.`;
    await openStored([
      { id: "u1", role: "user", parts: [{ type: "text", text: "When do I need a receipt?" }] },
      {
        id: "r1",
        role: "assistant",
        metadata: { status: "complete" },
        parts: reply(text, [kept("S1", "any claim over £25")]).parts as never,
      },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Source 1: Expenses FAQ.pdf, page 3" }));
    const { sheet, link } = await sheetLink();
    expect(within(sheet).getByText("Page 3")).toBeInTheDocument();
    expect(
      after(link.getAttribute("href"), V2),
      "the link should end in #page=3: without the fragment the PDF opens at page 1, and ?page=3 goes to the " +
        "server, which ignores it",
    ).toBe("#page=3");
  });

  it("opens a document without pages with no fragment", async () => {
    const text = `Notes ${marker("S2", "the office closes at six")}.`;
    vi.mocked(getCitedChunk).mockResolvedValue({
      chunkId: SOURCES[1].chunkId,
      text: "The office closes at six on Fridays.",
      section: null,
      pageStart: null,
      pageEnd: null,
      document: { id: NOTES, title: "Office notes.md", path: "/HR/Office notes.md", mimeType: "text/markdown" },
    } as never);
    await openStored([
      { id: "u1", role: "user", parts: [{ type: "text", text: "When does the office close?" }] },
      {
        id: "r1",
        role: "assistant",
        metadata: { status: "complete" },
        parts: reply(text, [kept("S2", "the office closes at six")]).parts as never,
      },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Source 1: Office notes.md" }));
    const { link } = await sheetLink();
    expect(after(link.getAttribute("href"), NOTES), "a markdown file has no pages: its link has no #page= at all").toBe(
      "",
    );
  });
});

describe("the worked example", () => {
  it("turns Leo's six markers into chips 1, 2, 3, 2, 4, and chip 1 opens policy v2 at page 2", async () => {
    await openStored(conversation.messages);
    expect(chips()).toEqual([
      "1 Travel and Expenses Policy v2.pdf, page 2",
      "2 Travel and Expenses Policy v2.pdf, page 1",
      "3 Travel and Expenses Policy.pdf, page 2",
      "2 Travel and Expenses Policy v2.pdf, page 1",
      "4 Travel and Expenses Policy v2.pdf, page 2",
    ]);

    fireEvent.click(screen.getAllByRole("button", { name: "Source 1: Travel and Expenses Policy v2.pdf, page 2" })[0]);
    const { sheet, link } = await sheetLink();
    expect(within(sheet).getByText("Page 2")).toBeInTheDocument();
    // The section under the title, and the chunk's own heading.
    expect(within(sheet).getAllByText("4. Limits")).toHaveLength(2);
    expect(within(sheet).getByText("£40 a day")).toBeInTheDocument();
    expect(after(link.getAttribute("href"), V2)).toBe("#page=2");
    await waitFor(() =>
      expect(getCitedChunk).toHaveBeenCalledWith({ data: { chunkId: "9fcb2ec3-d9f3-44dc-8031-92974337d2fe" } }),
    );
  });
});
