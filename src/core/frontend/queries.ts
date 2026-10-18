import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { notFound } from "@tanstack/react-router";
import { z } from "zod";

import type { RunPlacement } from "@/components/chat/chat-view";
import type { ConversationSummary, StoredUIMessage } from "@/components/chat/types";

import { getConversation, getConversationRuns, getConversations } from "@/routes/chat/-functions";

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
  if (!z.uuid().safeParse(conversationId).success) throw notFound();
  const [conversation, runs] = await Promise.all([
    getConversation({ data: { id: conversationId } }),
    getConversationRuns({ data: { conversationId } }),
  ]);
  return { ...conversation, runs };
}

/** The viewer's conversations, newest first, for the sidebar. The chat refreshes them after each answer by this key. */
export function useConversations(): UseQueryResult<ConversationSummary[]> {
  return useQuery({ queryKey: ["conversations"], queryFn: () => getConversations() });
}
