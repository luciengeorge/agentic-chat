// 👨‍💼 gpt-6-luna takes a few seconds to write Leo's answer. Kestrel's chat shows it as it's written: the sources
//    first, then the words, then the citations. This file turns the answer's events into what the browser's
//    `useChat` reads.
//
// 🦉 New in this file: `StreamedAnswer`, `sourceRef` (a source without its text) and `verdictOf` (the validator's
//    result as the browser gets it). The route writes `start` before your parts and `finish` after.

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
  // 🐨 Walk the events as they come and write each one to the stream as it arrives, keeping `streamed` up to date:
  //    - `sources`: keep them (with their text) in `streamed.sources`, and write one `data-sources` part whose data
  //      is `{ sources }` with each source turned into a `SourceRef`.
  //    - `text-delta`: before the first one, write `text-start`; then write a `text-delta` with the delta, and add
  //      it to `streamed.text`. Every text part uses the same id.
  //    - `done`: keep the result, write `text-end` if a text part was started, then one `data-verdict` part.
  // 🐨 The classic mistakes: a `text-start` for every delta (each one becomes a separate text part in the browser),
  //    sending the sources with their text, and collecting the deltas to write at the end.
  //
  // 💰 `writer.write({ type: "text-delta", id: "text", delta })`. Parts: `{ type: "data-sources", id: "sources", data
  //    }`, `{ type: "text-start", id: "text" }`, `{ type: "text-end", id: "text" }`, `{ type: "data-verdict", id:
  //    "verdict", data }`. `sourceRef(source)` and `verdictOf(result)` make the data.
  //
  // 🦉 How the browser reads this. `useChat` builds one assistant message from the parts as they land: a
  //    `text-start` opens a text part, each `text-delta` with the same id appends to it, `text-end` closes it. A
  //    `data-<name>` part arrives whole, and one with an id the message already holds replaces it. So Leo sees the
  //    sources list first, the answer growing word by word, then the citation chips once the verdict comes.
  // 🦉 Why the text stays behind. A source's text is the chunk itself, up to 512 tokens of it, eight times over.
  //    The browser only needs the label, title, path and pages to draw a chip; it fetches a chunk when Leo opens
  //    one, through a route that checks he may read it. Sending all eight with every answer is kilobytes for
  //    nothing.
  // 🦉 Why keep `streamed` as you go. If Leo closes the tab halfway, the model call throws and this function with
  //    it. The route catches that and stores what he saw, so `streamed.text` has to hold every delta already
  //    written, not only the finished answer.
  //
  // 📜 https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol
  //
  // 🚨 The tests check the order of parts, one text part, no chunk text in the sources, each delta written before
  //    the model's next one exists, `streamed` kept up through an abort, and Leo's London answer as `useChat`
  //    rebuilds it.
  throw new Error(
    `writeAnswer(${typeof writer}, ${typeof events}, ${streamed.text.length} characters so far) isn't written yet`,
  );
}
