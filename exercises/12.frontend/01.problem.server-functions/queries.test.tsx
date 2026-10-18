import { isNotFound } from "@tanstack/react-router";
import { act, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadConversationPage } from "#learn/frontend/queries";
import { ChatSidebar } from "@/components/chat/sidebar";
import { mealAllowance } from "@/core/frontend/recorded";
import { deferred, fakeFetch, renderInApp, testQueryClient } from "@/core/frontend/testing";
import { getConversation, getConversationRuns, getConversations } from "@/routes/chat/-functions";

vi.mock("@/routes/chat/-functions", () => ({
  getConversation: vi.fn(),
  getConversationRuns: vi.fn(),
  getConversations: vi.fn(),
  getCitedChunk: vi.fn(),
  ensureConversation: vi.fn(),
}));

const leo = { name: "Leo Martin", email: "leo.martin@kestrelpay.example", tenant: { slug: "kestrel" } };
const { conversationId, conversation, runs, conversationsBefore, conversationsAfter } = mealAllowance;
const newest = conversationsAfter[0];

const sidebarLinks = () =>
  within(screen.getByRole("navigation", { name: "Conversations" }))
    .queryAllByRole("link")
    .map((link) => link.textContent);

beforeEach(() => {
  vi.mocked(getConversation).mockReset();
  vi.mocked(getConversationRuns).mockReset();
  vi.mocked(getConversations).mockReset();
  fakeFetch({ "/api/approvals?status=pending": () => Response.json({ approvals: [] }) });
});

describe("the conversation page's loader", () => {
  it("asks for the messages and the runs at the same time, and waits for both", async () => {
    const messages = deferred<typeof conversation>();
    const theRuns = deferred<typeof runs>();
    vi.mocked(getConversation).mockReturnValue(messages.promise as never);
    vi.mocked(getConversationRuns).mockReturnValue(theRuns.promise as never);

    const page = loadConversationPage(conversationId);
    page.catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    expect(getConversation, "getConversation wasn't called").toHaveBeenCalledWith({ data: { id: conversationId } });
    expect(
      getConversationRuns,
      "getConversationRuns wasn't asked while getConversation was still waiting: start both, then wait for them " +
        "together (Promise.all), or the page waits for the sum of the two",
    ).toHaveBeenCalledWith({ data: { conversationId } });

    theRuns.resolve(runs);
    messages.resolve(conversation);
    expect(await page).toEqual({ ...conversation, runs });
  });

  it("answers a link that isn't a conversation id with a 404, and never asks the server", async () => {
    let thrown: unknown = null;
    try {
      await loadConversationPage("hello");
    } catch (error) {
      thrown = error;
    }
    expect(isNotFound(thrown), "`/chat/hello` should throw notFound(), so the router shows its 404 page").toBe(true);
    expect(getConversation, "the id was checked after asking the server").not.toHaveBeenCalled();
    expect(getConversationRuns, "the id was checked after asking the server").not.toHaveBeenCalled();
  });
});

describe("the sidebar's list", () => {
  it("is fetched once for the whole page, however many components show it", async () => {
    vi.mocked(getConversations).mockResolvedValue(conversationsBefore as never);
    await renderInApp(() => (
      <>
        <ChatSidebar activeId={undefined} viewer={leo} />
        <ChatSidebar activeId={undefined} viewer={leo} />
      </>
    ));
    expect(await screen.findAllByRole("navigation", { name: "Conversations" })).toHaveLength(2);
    await screen.findAllByText(conversationsBefore[0].title!);
    expect(
      getConversations,
      "each sidebar fetched its own list: that's what a useEffect does. A query shares one request per key",
    ).toHaveBeenCalledTimes(1);
  });

  it("shows a list already in the cache on its first draw, without waiting for the server", async () => {
    vi.mocked(getConversations).mockReturnValue(new Promise(() => {}) as never);
    const client = testQueryClient();
    client.setQueryData(["conversations"], conversationsBefore);
    await renderInApp(() => <ChatSidebar activeId={undefined} viewer={leo} />, client);
    expect(
      sidebarLinks(),
      "the first draw didn't show the list cached under ['conversations']: an effect only fetches after the " +
        "component has drawn, and a query under another key can't see it",
    ).toHaveLength(conversationsBefore.length);
  });

  it("asks again when the chat says the list changed, and shows the new conversation on top", async () => {
    vi.mocked(getConversations).mockResolvedValue(conversationsBefore as never);
    const { client } = await renderInApp(() => <ChatSidebar activeId={undefined} viewer={leo} />);
    await screen.findAllByText(conversationsBefore[0].title!);

    vi.mocked(getConversations).mockResolvedValue(conversationsAfter as never);
    // What the chat does when an answer is in (step 2).
    await act(() => client.invalidateQueries({ queryKey: ["conversations"] }));
    expect(
      getConversations,
      "invalidating ['conversations'] didn't fetch the list again: the query must use exactly that key, and " +
        "a list kept in useState never hears about it",
    ).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(sidebarLinks()[0]).toBe(newest.title));
  });

  it("works through Leo's real sidebar: 49 conversations, then 50 with the meal allowance question on top", async () => {
    vi.mocked(getConversation).mockResolvedValue(conversation as never);
    vi.mocked(getConversationRuns).mockResolvedValue(runs as never);
    vi.mocked(getConversations).mockResolvedValue(conversationsBefore as never);

    const { client } = await renderInApp(() => <ChatSidebar activeId={conversationId} viewer={leo} />);
    await screen.findAllByText(conversationsBefore[0].title!);
    expect(sidebarLinks()).toHaveLength(49);

    vi.mocked(getConversations).mockResolvedValue(conversationsAfter as never);
    await act(() => client.invalidateQueries({ queryKey: ["conversations"] }));
    await waitFor(() => expect(sidebarLinks()).toHaveLength(50));
    const first = within(screen.getByRole("navigation", { name: "Conversations" })).getAllByRole("link")[0];
    expect(first).toHaveTextContent("What's the daily meal allowance on a work trip?");
    expect(first).toHaveAttribute("href", `/chat/${conversationId}`);

    const page = await loadConversationPage(conversationId);
    expect(page.title).toBe("What's the daily meal allowance on a work trip?");
    expect(page.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(page.runs).toEqual([]);
  });
});
