import type { UIMessageStreamWriter } from "ai";

import type { CitableSource } from "#learn/cite/citations";
import type { AnswerEvent, AnswerResult } from "#learn/generate/answer";
import type { ChatUIMessage, SourceRef, Verdict } from "@/components/chat/types";

/** What has gone out so far, kept by the caller: if the client leaves halfway, it stores the part that was seen. */
export interface StreamedAnswer {
  /** The sources the model saw, with their text, which stays on the server for the validator. */
  sources: CitableSource[];
  text: string;
  result: AnswerResult | null;
}

/** A source as the browser gets it: everything but the chunk's text. */
export const sourceRef = ({ text: _text, ...ref }: CitableSource): SourceRef => ref;

/** The validator's result as the browser gets it. */
export const verdictOf = (result: AnswerResult): Verdict => ({
  citations: result.report.citations,
  dropped: result.report.dropped,
  abstained: result.abstained,
  flagged: result.flagged,
});

/**
 * Writes one answer to the AI SDK's UI message stream, as it happens: the sources, then the text as one text part
 * (`text-start`, a `text-delta` per piece, `text-end`), then the verdict. The caller writes `start` before and
 * `finish` after. `streamed` keeps up as events go out, so a throw (an abort) leaves what was sent in it.
 */
export async function writeAnswer(
  writer: UIMessageStreamWriter<ChatUIMessage>,
  events: AsyncIterable<AnswerEvent>,
  streamed: StreamedAnswer,
): Promise<void> {
  let textStarted = false;
  for await (const event of events) {
    if (event.type === "sources") {
      streamed.sources = event.sources;
      writer.write({ type: "data-sources", id: "sources", data: { sources: event.sources.map(sourceRef) } });
    } else if (event.type === "text-delta") {
      if (!textStarted) writer.write({ type: "text-start", id: "text" });
      textStarted = true;
      streamed.text += event.delta;
      writer.write({ type: "text-delta", id: "text", delta: event.delta });
    } else {
      streamed.result = event.result;
      if (textStarted) writer.write({ type: "text-end", id: "text" });
      writer.write({ type: "data-verdict", id: "verdict", data: verdictOf(event.result) });
    }
  }
}
