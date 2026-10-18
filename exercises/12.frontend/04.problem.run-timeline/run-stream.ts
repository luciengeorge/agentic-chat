// 👨‍💼 An agent run can wait a week on Leo's approval, and he'll reload the page, switch tabs and close the laptop
//    in between. Each time the page comes back, its timeline must be exactly the run's: every step once, in
//    order, and the decision that was made. This file follows one run's event stream for the page.

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
  // 🐨 If the state already holds an event with this seq, return `state` itself, unchanged. The store checks for
  //    exactly that object to know nothing happened (it then skips saving and drawing).
  // 🐨 Otherwise return a new state: the events with this one added at the end. If the event is an
  //    "assistant_turn", the turn the tokens were spelling out is now whole in the event, so `streaming` goes
  //    back to "". Any other event leaves `streaming` as it was.
  //
  // 💰 state.events.some((e) => e.seq === event.seq); event.data.type === "assistant_turn"
  //
  // 🦉 Why an event can arrive twice. Several connections feed one store over its life: the first page load,
  //    the browser's own reconnects, a reload. Each starts from what the page knew at that moment, and a reload
  //    that saved its events but asked for the stream from the top gets all of them again. The seq is the
  //    event's identity in the log (Postgres keeps (run_id, seq) unique), so "have I got seq 11?" is the only
  //    question that never goes wrong, whatever the server sent.
  // 🦉 Why tokens give way to the turn. Tokens are the model's words as it writes them; they're never stored. The
  //    turn's event, written once the model is done, holds the whole text. The timeline draws the turn from the
  //    event, and `streaming` below it. Keep both, and the draft shows twice; drop the event's text, and a reload
  //    (which gets no tokens for a turn already written) shows nothing.
  //
  // 🚨 The tests check that an event already held changes nothing, and that a turn's text shows once.
  throw new Error(`receive(${state.events.length} events, seq ${event.seq}) isn't written yet`);
}

/** Where this tab's stream starts: after the last event it already holds, or at the top. */
export function streamUrl(runId: string, events: readonly RunEvent[]): string {
  // 🐨 The stream is /api/runs/<runId>/stream. If the tab already holds events (a reload kept them in
  //    sessionStorage), ask for what came after the last one: ?after=<its seq>. With none, start at the top,
  //    with no query at all.
  //
  // 🦉 Who sends what on a reconnect. Each event line carries `id: <seq>`, so the browser's EventSource always
  //    knows the last event it got. When the connection drops, it reconnects by itself, to the same URL, with
  //    the header Last-Event-ID: <that seq>, and the server (resumeFrom in src/routes/api/runs/-runs.ts) starts
  //    after it. A reload is different: the page and its EventSource start over and know nothing. The page
  //    itself must say where it was, from what it kept, and the URL is the only way an EventSource can say it
  //    (it can't set headers). The server reads the header first, then `?after=`, so a reconnect after a
  //    reload still resumes from the newer of the two.
  // 🦉 Why the token lines have no `id`. A token isn't stored. If it carried an id, Last-Event-ID could name
  //    a token, and the server couldn't resume from it.
  //
  // 📜 https://html.spec.whatwg.org/multipage/server-sent-events.html#the-last-event-id-header
  //
  // 🚨 The tests check the URL on a first visit and after a reload.
  throw new Error(`streamUrl(${runId}, ${events.length} events) isn't written yet`);
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

// 🦉 New in this file: nothing but `receive` and `streamUrl`. The rest is the store they plug into: `cached` and
//    `keep` (the tab's sessionStorage), one store and one EventSource per run however many components show it,
//    `subscribe` (opens the stream for the first component, closes it when the last leaves or the run is done),
//    and `useRunStream`, which src/components/agent/run-view.tsx calls.

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
