/**
 * Streaming through the boundary (section 11.5). A chat answer is a long response: retrieval and reasoning can keep
 * it quiet for seconds, and the reader can leave at any moment. This wraps the response body so a quiet stream
 * stays open, and a reader that leaves stops the work behind it.
 */

/** How often a quiet stream sends a heartbeat. */
export const HEARTBEAT_MS = 15_000;

const HEARTBEAT = new TextEncoder().encode(": heartbeat\n\n");

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
  const reader = body.getReader();
  let timer: ReturnType<typeof setInterval> | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        try {
          controller.enqueue(HEARTBEAT);
        } catch {
          clearInterval(timer);
        }
      }, intervalMs);
    },
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          clearInterval(timer);
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        clearInterval(timer);
        controller.error(error);
      }
    },
    async cancel(reason) {
      clearInterval(timer);
      onCancel();
      await reader.cancel(reason);
    },
  });
}
