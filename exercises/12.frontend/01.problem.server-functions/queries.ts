// 👨‍💼 Leo opens a conversation and its messages are simply there; he asks something new and it's on top of the
//    sidebar as soon as the answer is in. This file decides how the page and the sidebar get their data from the
//    server: the conversation page from its route's loader, the sidebar's list from a query.

import type { UseQueryResult } from "@tanstack/react-query";

import type { RunPlacement } from "@/components/chat/chat-view";
import type { ConversationSummary, StoredUIMessage } from "@/components/chat/types";

// 🦉 New in this file: nothing to write but the two functions. The server functions they call live in
//    src/routes/chat/-functions.ts (read them): getConversation({ data: { id } }) gives the title and the stored
//    messages, getConversationRuns({ data: { conversationId } }) the agent runs, getConversations() the list.

export interface ConversationPage {
  title: string | null;
  messages: StoredUIMessage[];
  runs: RunPlacement[];
}

/**
 * What the conversation page needs before it renders: the conversation's messages and its agent runs, asked for
 * together. A link that isn't a conversation id is a 404, and the server is never asked.
 */
export async function loadConversationPage(conversationId: string): Promise<ConversationPage> {
  // 🐨 First, check the id. The URL is typed by people and old links, so `/chat/hello` can arrive here. If it
  //    isn't a uuid, throw notFound() before you call anything: TanStack Router shows its 404 page.
  // 🐨 Then ask the server for the two things the page needs, getConversation and getConversationRuns. Start
  //    both before you wait for either, and wait for them together.
  // 🐨 Return the conversation's title and messages with the runs beside them: { ...conversation, runs }.
  //
  // 💰 import { notFound } from "@tanstack/react-router"; import { z } from "zod"; z.uuid().safeParse(id).success
  // 💰 import { getConversation, getConversationRuns } from "@/routes/chat/-functions";
  // 💰 const [a, b] = await Promise.all([first(), second()]);
  //
  // 🦉 Why a loader, and not a fetch inside the page. The router runs the loader before it draws the page, so
  //    the page draws once, with its data. On the first visit the loader runs on the server, where a server
  //    function is a plain call into the database, and the HTML comes back with the messages already in it. After
  //    that it runs in the browser, and the app even starts it when you hover a link (`defaultPreload: "intent"`
  //    in src/router.tsx), so by the time you click, the data is often there.
  // 🦉 Why together. Each server function from the browser is one round trip. `await a(); await b();` waits for
  //    the first before it even asks for the second, so the page waits for the sum of the two. Started together,
  //    it waits for the slower one only.
  //
  // 📜 https://tanstack.com/router/latest/docs/framework/react/guide/data-loading
  // 📜 https://tanstack.com/start/latest/docs/framework/react/guide/server-functions
  //
  // 🚨 The tests check that both requests start before either answers, that a bad id throws a not-found without
  //    asking the server, and that Leo's real conversation loads as the README says.
  throw new Error(`loadConversationPage(${conversationId}) isn't written yet`);
}

/** The viewer's conversations, newest first, for the sidebar. The chat refreshes them after each answer by this key. */
export function useConversations(): UseQueryResult<ConversationSummary[]> {
  // 🐨 Return a query for the list: the key ["conversations"], and getConversations() as the function that
  //    fetches it.
  // 🐨 Keep the key exactly ["conversations"]. When an answer finishes, the chat calls
  //    queryClient.invalidateQueries({ queryKey: ["conversations"] }) (step 2 writes that call), and that's how
  //    the sidebar learns its list changed. A query under any other key never hears about it.
  //
  // 💰 import { useQuery } from "@tanstack/react-query"; useQuery({ queryKey, queryFn })
  // 💰 import { getConversations } from "@/routes/chat/-functions";
  //
  // 🦉 Why a query, and not useEffect plus useState. An effect runs after the component has drawn, so the first
  //    draw is always empty, even when the list is already in memory from a moment ago. Each component with the
  //    effect fetches its own copy: the sidebar is drawn by /chat, /inbox and /labs alike. And the list lives
  //    inside that one component, so nothing else can say "this changed, fetch it again". A query lives in the
  //    cache instead, under its key: the first component to ask starts the request, every other one shares it,
  //    a component drawn later gets the cached copy on its first draw, and anyone holding the QueryClient can
  //    invalidate it.
  //
  // 📜 https://tanstack.com/query/latest/docs/framework/react/guides/query-keys
  // 📜 https://tanstack.com/query/latest/docs/framework/react/guides/query-invalidation
  //
  // 🚨 The tests check that two sidebars make one request, that a cached list shows on the first draw, and that
  //    invalidating ["conversations"] brings back the new list.
  throw new Error("useConversations() isn't written yet");
}
