import type { ReactNode } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";

/** A QueryClient for one test: no retries, so a failing query fails at once. */
export const testQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

/**
 * Renders `ui` the way the app does: inside a router (so `<Link>` works), a QueryClientProvider and the tooltip
 * provider. Resolves once the router has rendered.
 */
export async function renderInApp(ui: () => ReactNode, client: QueryClient = testQueryClient()) {
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <TooltipProvider delay={0}>{ui()}</TooltipProvider>
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultErrorComponent: ({ error }) => <pre data-render-error="">{(error as Error).message}</pre>,
  });
  await router.load();
  const view = render(<RouterProvider router={router as never} />);
  const failed = view.container.querySelector("[data-render-error]");
  if (failed) throw new Error(`the page failed to draw: ${failed.textContent}`);
  return { ...view, client, router };
}

/** A promise you settle from outside: a server function that answers when the test says so. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A response body that hands over the recorded reads only as the test releases them, so a test can look at the
 * page halfway through an answer. `release(n)` lets the next n reads through; `releaseAll()` the rest.
 */
export function gatedStream(reads: readonly { bytes: Uint8Array }[]) {
  let next = 0;
  let allowed = 0;
  let wake: (() => void) | null = null;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (next >= allowed) await new Promise<void>((done) => (wake = done));
      if (next >= reads.length) {
        controller.close();
        return;
      }
      controller.enqueue(reads[next++].bytes);
    },
  });
  const open = (n: number) => {
    allowed = Math.min(n, reads.length + 1);
    wake?.();
    wake = null;
  };
  return {
    response: () =>
      new Response(body, { headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" } }),
    release: (n: number) => open(allowed + n),
    releaseAll: () => open(reads.length + 1),
    get delivered() {
      return next;
    },
  };
}

/** One call to the fake `fetch`: the URL, the method and the body as JSON (or null). */
export interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

/**
 * Replaces `fetch` with one that answers by URL: `routes` maps a path (or a path prefix ending in `*`) to a
 * function that returns the response. Unknown URLs answer 404. Every call is kept in `calls`.
 */
export function fakeFetch(routes: Record<string, (call: FetchCall) => Response | Promise<Response>>) {
  const calls: FetchCall[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const raw = init?.body;
    const body = typeof raw === "string" ? JSON.parse(raw) : null;
    const call = { url: path, method: init?.method ?? "GET", body };
    calls.push(call);
    const route = Object.entries(routes).find(([key]) =>
      key.endsWith("*") ? path.startsWith(key.slice(0, -1)) : path === key,
    );
    return route ? route[1](call) : Response.json({ error: "not_found" }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  return { calls, fetch };
}

type Listener = (message: MessageEvent<string>) => void;

/**
 * A stand-in for the browser's `EventSource`. `FakeEventSource.opened` lists every connection, newest last; a test
 * plays the server through `send`. Like the browser, it remembers the last `id:` it saw (`lastEventId`).
 */
export class FakeEventSource {
  static opened: FakeEventSource[] = [];
  static get last(): FakeEventSource {
    const source = FakeEventSource.opened.at(-1);
    if (!source) throw new Error("no EventSource was opened");
    return source;
  }

  onmessage: Listener | null = null;
  readonly listeners = new Map<string, Listener[]>();
  closed = false;
  lastEventId = "";

  constructor(readonly url: string) {
    FakeEventSource.opened.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close() {
    this.closed = true;
  }

  /** Delivers one server-sent event, as the browser would: `message` to `onmessage`, others to their listeners. */
  send({ event, id, data }: { event: string; id: string | null; data: string }) {
    if (this.closed) return;
    if (id !== null) this.lastEventId = id;
    const message = new MessageEvent<string>(event, { data, lastEventId: this.lastEventId });
    if (event === "message") this.onmessage?.(message);
    for (const listener of this.listeners.get(event) ?? []) listener(message);
  }

  static install() {
    FakeEventSource.opened = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  }
}
