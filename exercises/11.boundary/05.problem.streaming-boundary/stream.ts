// 👨‍💼 A chat answer is a long response. It can be quiet for seconds while retrieval and the model work, and Leo can
//    close the tab at any moment. Kestrel needs the first not to end the connection, and the second to stop the
//    work, and the bill, at once.

/**
 * Streaming through the boundary (section 11.5). A chat answer is a long response: retrieval and reasoning can keep
 * it quiet for seconds, and the reader can leave at any moment. This wraps the response body so a quiet stream
 * stays open, and a reader that leaves stops the work behind it.
 */

/** How often a quiet stream sends a heartbeat. */
export const HEARTBEAT_MS = 15_000;

/**
 * Sends an SSE comment every `intervalMs` while the answer is quiet (retrieval and reasoning can take a while),
 * so proxies don't close an idle connection. Clients ignore comments. Upstream chunks are whole events, so a
 * heartbeat never lands inside one. `onCancel` runs when the client goes away.
 */
export function withHeartbeat(
  body: ReadableStream<Uint8Array>,
  intervalMs: number,
  onCancel: () => void,
): ReadableStream<Uint8Array> {
  // 🐨 Return a new ReadableStream that reads `body` and passes each chunk on, whole and in order, closing when it's
  //    done and erroring when it errors.
  // 🐨 While it's open, every `intervalMs` it also sends the heartbeat: the bytes of `": heartbeat\n\n"`. Stop the
  //    timer the moment the stream ends: when `body` is done, when it errors, and when the reader cancels.
  // 🐨 When the reader cancels (Leo closed the tab), call `onCancel` and cancel `body` too.
  // 🐨 The classic mistake: a `cancel` that doesn't call `onCancel`. Nothing fails; the page is gone; and the model
  //    keeps writing, billed, to a stream nobody reads.
  //
  // 💰 `body.getReader()` and `await reader.read()` give `{ value, done }`. `new ReadableStream({ start(controller),
  //    pull(controller), cancel(reason) })`: `start` runs once, `pull` whenever the reader wants more, `cancel` when
  //    it gives up. `controller.enqueue(bytes)`, `controller.close()`, `controller.error(e)`. `setInterval`,
  //    `clearInterval`. `new TextEncoder().encode(text)`. Enqueueing on a closed stream throws.
  //
  // 🦉 Why heartbeats. Between the request and the first word, retrieval rewrites the question, embeds it, searches,
  //    reranks, and the model reasons: seconds of silence. Proxies and load balancers close a connection that has
  //    sent nothing for a while (often 30 to 60 seconds), and the answer is lost. A server-sent events line starting
  //    with `:` is a comment: it keeps bytes flowing, and every reader, `useChat` included, skips it.
  // 🦉 Why a heartbeat never lands inside an event. Your stream hands over whole chunks, and the UI message stream
  //    writes one event per chunk. A heartbeat goes between two chunks, so it can't split one.
  // 🦉 How a closed tab reaches the model. When the browser goes away, the server's response stream is cancelled:
  //    your `cancel`. `onCancel` aborts the route's AbortController; that signal went to `answer()` and on to the
  //    model call, whose HTTP request to OpenAI is cut. The route then stores what Leo saw, marked `aborted`. The
  //    request's own `signal` does the same where the runtime fires it; the cancelled body is the one that always
  //    comes.
  // 🦉 Why pull, not a loop in start. `pull` asks for the next chunk only when the reader is ready for it, so a slow
  //    reader slows the reading of `body` (backpressure) instead of piling chunks up in memory.
  //
  // 📜 https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream/ReadableStream
  // 📜 https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
  //
  // 🚨 The tests check chunks pass whole and in order, heartbeats while quiet and none after the end, an upstream
  //    error passed on, a cancel that calls onCancel once and cancels the body, and Leo closing the tab on his
  //    London answer: the model call aborted and the reply stored as stopped.
  throw new Error(`withHeartbeat(${typeof body}, every ${intervalMs} ms, ${typeof onCancel}) isn't written yet`);
}
