import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatView } from "@/components/chat/chat-view";
import { mealAllowance } from "@/core/frontend/recorded";
import { fakeFetch, gatedStream, renderInApp, testQueryClient } from "@/core/frontend/testing";

vi.mock("@/routes/chat/-functions", () => ({
  getConversation: vi.fn(),
  getConversationRuns: vi.fn(),
  getConversations: vi.fn(),
  getCitedChunk: vi.fn(),
  ensureConversation: vi.fn(),
}));

const { question, conversationId, routed, reads, conversation } = mealAllowance;
/** The answer's last sentence, as the page shows it (citation markers become chips). */
const LAST_SENTENCE = /more than 10 hours in a day\./;

function serve(stream = gatedStream(reads)) {
  const fetch = fakeFetch({
    "/api/chat/router": () => Response.json(routed),
    "/api/chat": () => stream.response(),
  });
  const chatBody = () => fetch.calls.find((call) => call.url === "/api/chat")?.body as Record<string, unknown>;
  return { stream, fetch, chatBody };
}

async function openChat(initialMessages = [] as typeof conversation.messages, client = testQueryClient()) {
  return renderInApp(() => <ChatView id={conversationId} initialMessages={initialMessages} />, client);
}

async function ask(text: string) {
  const box = screen.getByRole("textbox", { name: "Ask a question" });
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
}

/** Waits for `text` to show, and fails with `why` if it never does. */
async function shows(text: string | RegExp, why: string, options?: { selector: string }) {
  const found = await screen.findAllByText(text, options).catch(() => []);
  expect(found.length, why).toBeGreaterThan(0);
  return found[0];
}

const releaseUntil = async (stream: ReturnType<typeof gatedStream>, reads: number) => {
  await act(async () => stream.release(reads - stream.delivered));
};

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("the chat's request", () => {
  it("sends the conversation's id and only the new message: the server keeps the history", async () => {
    const { stream, chatBody } = serve();
    await openChat(conversation.messages);
    await ask("And for a hotel in London?");
    await waitFor(() => expect(chatBody(), "nothing was sent to /api/chat").toBeDefined());
    stream.releaseAll();

    const body = chatBody();
    expect(
      Object.keys(body).sort(),
      "the body should be { id, message }: useChat sends `messages` (the whole history) unless " +
        "prepareSendMessagesRequest says otherwise",
    ).toEqual(["id", "message"]);
    expect(body.id, "the body's id isn't the conversation's: pass `id` to useChat").toBe(conversationId);
    expect(body.message).toMatchObject({ role: "user", parts: [{ type: "text", text: "And for a hotel in London?" }] });
  });

  it("starts from the stored messages, before it asks the server anything", async () => {
    const { fetch } = serve();
    await openChat(conversation.messages);
    expect(
      screen.queryAllByText(question, { selector: "div" }),
      "the stored question isn't on the page: give useChat the stored messages to start from",
    ).toHaveLength(1);
    expect(screen.getByText(LAST_SENTENCE)).toBeInTheDocument();
    expect(fetch.calls).toEqual([]);
  });
});

describe("the reply as it streams", () => {
  it("says it's searching, then how many sources it reads, then shows the words as they come", async () => {
    const { stream } = serve();
    await openChat();
    fireEvent.click(screen.getByRole("button", { name: question }));

    await releaseUntil(stream, 1);
    await shows("Searching your documents…", "after `start`, the page should say it's searching");

    await releaseUntil(stream, 2);
    await shows(
      "Reading 8 sources…",
      "the data-sources part arrived, but the page didn't count its sources: read them in replyParts",
    );

    await releaseUntil(stream, 3);
    await shows(
      /^For/,
      "the first delta, 'For', arrived but isn't on the page: add up the text parts while they stream, not " +
        "only once they're done",
    );
    expect(screen.queryByText(LAST_SENTENCE)).toBeNull();
  });

  it("shows the finished answer once, and tells the sidebar its list changed", async () => {
    const { stream } = serve();
    const client = testQueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await openChat([], client);
    fireEvent.click(screen.getByRole("button", { name: question }));
    stream.releaseAll();

    await shows("Sources", "the answer never finished: no Sources list under it");
    expect(
      screen.getAllByText("Sources"),
      "the answer shows more than once: useChat already holds the reply, so onFinish mustn't add it",
    ).toHaveLength(1);
    await waitFor(() =>
      expect(
        invalidate,
        "when the answer finished, ['conversations'] wasn't invalidated: that's onFinish's job",
      ).toHaveBeenCalledWith({ queryKey: ["conversations"] }),
    );
    expect(
      screen.getAllByText(LAST_SENTENCE),
      "the answer shows more than once: useChat already holds the reply, so onFinish mustn't add it",
    ).toHaveLength(1);
    expect(screen.getAllByText(question, { selector: "div" })).toHaveLength(1);
  });
});

describe("the worked example", () => {
  it("replays Leo's meal allowance answer: 158 reads, the first word at read 2, £40 by read 21", async () => {
    expect(reads).toHaveLength(158);
    expect(reads.reduce((sum, read) => sum + read.bytes.length, 0)).toBe(13_286);
    expect([reads[1].at, reads[2].at, reads[21].at]).toEqual([3167, 6668, 6786]);

    const { stream } = serve();
    await openChat();
    fireEvent.click(screen.getByRole("button", { name: question }));

    await releaseUntil(stream, 22);
    const partial = await shows(/the daily meal allowance is/, "by read 21 the answer's first sentence should show");
    // The bold isn't closed yet, so its opening asterisks show as text until the next delta.
    expect(partial.textContent).toBe("For costs incurred on or after 1 July 2026, the daily meal allowance is **£40");
    expect(screen.queryByText("Sources")).toBeNull();

    stream.releaseAll();
    await shows("Sources", "the answer never finished: no Sources list under it");
    expect(screen.getAllByText("Sources"), "the answer shows more than once").toHaveLength(1);
    expect(screen.getByText(/the daily meal allowance is/).textContent).toContain("the daily meal allowance is £40.");
    expect(screen.getByText(/the previous allowance was/).textContent).toContain(
      "the previous allowance was £35 a day.",
    );
  });
});
