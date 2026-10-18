import { useCallback, useSyncExternalStore } from "react";

import type { RunEvent } from "#learn/agent/types";

import { FINAL } from "@/components/agent/timeline";

export interface RunState {
  events: RunEvent[];
  /** The text of the turn in progress, from token lines. */
  streaming: string;
}

/**
 * The state after one event from the stream. An event it already holds (the same `seq`) changes nothing, and the
 * same state comes back. An `assistant_turn` holds its turn's whole text, so the streamed tokens give way to it.
 */
export function receive(state: RunState, event: RunEvent): RunState {
  if (state.events.some((e) => e.seq === event.seq)) return state;
  return { events: [...state.events, event], streaming: event.data.type === "assistant_turn" ? "" : state.streaming };
}

/** Where this tab's stream starts: after the last event it already holds, or at the top. */
export function streamUrl(runId: string, events: readonly RunEvent[]): string {
  const after = events.at(-1)?.seq;
  return `/api/runs/${runId}/stream${after ? `?after=${after}` : ""}`;
}

const EMPTY: RunState = { events: [], streaming: "" };
const cacheKey = (runId: string) => `run-events:${runId}`;

function cached(runId: string): RunEvent[] {
  try {
    const raw = sessionStorage.getItem(cacheKey(runId));
    return raw ? (JSON.parse(raw) as RunEvent[]) : [];
  } catch {
    return [];
  }
}

function keep(runId: string, events: readonly RunEvent[]) {
  try {
    sessionStorage.setItem(cacheKey(runId), JSON.stringify(events));
  } catch {
    // full or blocked: a reload replays the stream from the top instead
  }
}

const finished = (events: readonly RunEvent[]) => events.some((e) => e.data.type === "status" && FINAL.has(e.data.to));

interface Store {
  state: RunState;
  listeners: Set<() => void>;
  source: EventSource | null;
}

const stores = new Map<string, Store>();

function storeFor(runId: string): Store {
  let store = stores.get(runId);
  if (!store) {
    store = { state: { events: cached(runId), streaming: "" }, listeners: new Set(), source: null };
    stores.set(runId, store);
  }
  return store;
}

function set(store: Store, state: RunState) {
  store.state = state;
  for (const listener of store.listeners) listener();
}

/** Opens the stream when the first component subscribes, and closes it when the last one leaves. */
function subscribe(runId: string, listener: () => void): () => void {
  const store = storeFor(runId);
  store.listeners.add(listener);
  if (!store.source && !finished(store.state.events)) {
    const source = new EventSource(streamUrl(runId, store.state.events));
    store.source = source;
    source.onmessage = (message: MessageEvent<string>) => {
      const next = receive(store.state, JSON.parse(message.data) as RunEvent);
      if (next === store.state) return;
      keep(runId, next.events);
      set(store, next);
      if (finished(next.events)) {
        source.close();
        store.source = null;
      }
    };
    source.addEventListener("token", (message: MessageEvent<string>) => {
      const { delta } = JSON.parse(message.data) as { delta: string };
      set(store, { ...store.state, streaming: store.state.streaming + delta });
    });
  }
  return () => {
    store.listeners.delete(listener);
    if (store.listeners.size === 0) {
      store.source?.close();
      store.source = null;
    }
  };
}

/** What a reload does to this module: the streams and what they held in memory go, the tab's sessionStorage
 * stays. Tests call it. */
export function forgetRunStreams() {
  for (const store of stores.values()) store.source?.close();
  stores.clear();
}

/**
 * Follows a run's event stream. The events seen so far are kept for the tab (sessionStorage), so a reload starts
 * the stream after the last one (`?after=`), and the browser's own reconnects send `Last-Event-ID`. Tokens are the
 * text of the turn in progress; its `assistant_turn` event, which holds all of it, replaces them. The server render
 * has no events: the browser fills them in after hydration.
 */
export function useRunStream(runId: string): RunState {
  return useSyncExternalStore(
    useCallback((listener: () => void) => subscribe(runId, listener), [runId]),
    () => storeFor(runId).state,
    () => EMPTY,
  );
}
