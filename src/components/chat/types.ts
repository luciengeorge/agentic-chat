import type { UIMessage } from "ai";

import type { Citation, DroppedCitation } from "#learn/cite/citations";

/** A source the model was shown, without its text. */
export interface SourceRef {
  label: string;
  chunkId: string;
  documentId: string;
  title: string;
  path: string;
  pageStart: number | null;
  pageEnd: number | null;
}

export interface Verdict {
  citations: Citation[];
  dropped: DroppedCitation[];
  abstained: boolean;
  flagged: boolean;
}

export type ReplyStatus = "complete" | "aborted";

export type ChatUIMessage = UIMessage<
  { status?: ReplyStatus },
  {
    sources: { sources: SourceRef[] };
    verdict: Verdict;
  }
>;

export interface ConversationSummary {
  id: string;
  title: string | null;
  updatedAt: string;
}

/** A stored message as `useChat` takes it: the parts this app writes, and nothing a server function can't send. */
export type StoredUIMessage =
  | { id: string; role: "user"; parts: Array<{ type: "text"; text: string }> }
  | {
      id: string;
      role: "assistant";
      metadata: { status: ReplyStatus };
      parts: Array<
        | { type: "data-sources"; id: string; data: { sources: SourceRef[] } }
        | { type: "text"; text: string; state: "done" }
        | { type: "data-verdict"; id: string; data: Verdict }
      >;
    };
