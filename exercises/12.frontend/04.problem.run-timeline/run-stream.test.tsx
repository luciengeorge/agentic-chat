import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import type { RunEvent } from "#learn/agent/types";

import { forgetRunStreams } from "#learn/frontend/run-stream";
import { RunView } from "@/components/agent/run-view";
import { kpcEmailRun, type SseMessage } from "@/core/frontend/recorded";
import { FakeEventSource, fakeFetch, renderInApp } from "@/core/frontend/testing";

const { runId, first, second, approval, events } = kpcEmailRun;
const STREAM = `/api/runs/${runId}/stream`;
const DRAFT = /^I found the contract’s payment terms and Tom’s directory entry\./;
const DONE = "Emailed Tom Whitfield the two-line summary of payment terms in KPC-2026-0142.";

/** The server's side: sends these messages down the newest connection. */
const play = (messages: readonly SseMessage[]) =>
  act(() => {
    for (const message of messages) FakeEventSource.last.send(message);
  });
const asMessage = (event: RunEvent): SseMessage => ({
  event: "message",
  id: String(event.seq),
  data: JSON.stringify(event),
});
const upTo = (seq: number) => first.messages.slice(0, first.messages.findIndex((m) => m.id === String(seq)) + 1);

const showRun = () => renderInApp(() => <RunView runId={runId} />);

/** What a reload does: the page's memory goes, the tab's sessionStorage stays. */
async function reload(view: Awaited<ReturnType<typeof showRun>>) {
  view.unmount();
  forgetRunStreams();
  return showRun();
}

const card = () => screen.getByRole("region", { name: "Send this email?" });
const rows = (text: string | RegExp) => screen.queryAllByText(text);

let decisions: unknown[];
beforeEach(() => {
  forgetRunStreams();
  sessionStorage.clear();
  FakeEventSource.install();
  decisions = [];
  fakeFetch({
    [`/api/approvals/${approval.id}`]: (call) => {
      decisions.push(call.body);
      return Response.json({ id: approval.id, decision: (call.body as { decision: string }).decision });
    },
  });
});

describe("following a run", () => {
  it("opens the stream from the top on a first visit, and draws each event as it arrives", async () => {
    await showRun();
    expect(
      [STREAM, `${STREAM}?after=0`],
      `with no events kept, the stream starts at the top (${STREAM}), not ${FakeEventSource.last.url}`,
    ).toContain(FakeEventSource.last.url);
    await play(first.messages);
    expect(screen.getByText("Searched for “contract KPC-2026-0142 payment terms”")).toBeInTheDocument();
    expect(screen.getByText("Looked up “Tom Whitfield”")).toBeInTheDocument();
    expect(within(card()).getByText("Payment terms — KPC-2026-0142")).toBeInTheDocument();
    expect(screen.getByText("Waiting for you")).toBeInTheDocument();
  });

  it("shows the draft while its tokens stream, then the turn's own text, once", async () => {
    await showRun();
    const beforeTurn = upTo(9).concat(first.messages.slice(upTo(9).length).filter((m) => m.event === "token"));
    await play(beforeTurn);
    expect(rows(DRAFT), "the 41 tokens before seq 10 should show as the draft").toHaveLength(1);

    await play([first.messages.find((m) => m.id === "10")!]);
    expect(
      rows(DRAFT),
      "the draft shows twice: when the assistant_turn arrives, it holds the whole text, so `streaming` goes back to ''",
    ).toHaveLength(1);
  });

  it("shows a turn's text even when the page never saw its tokens", async () => {
    // Tokens are sent only to a page that's connected while the model writes; a later page gets the events alone.
    await showRun();
    await play(events.slice(0, 12).map(asMessage));
    expect(
      rows(DRAFT),
      "seq 10's text didn't show: the assistant_turn event holds the whole text, tokens or not",
    ).toHaveLength(1);
  });
});

describe("coming back", () => {
  it("after a reload, asks only for what came after the last event it kept", async () => {
    const view = await showRun();
    await play(first.messages);
    await reload(view);

    expect(FakeEventSource.last.url.startsWith(STREAM)).toBe(true);
    expect(
      FakeEventSource.last.url.slice(STREAM.length),
      "the tab holds seq 1 to 12, so the reload should ask for what came after the last: ?after=12",
    ).toBe("?after=12");
    expect(within(card()).getByText("Payment terms — KPC-2026-0142")).toBeInTheDocument();
    expect(JSON.parse(sessionStorage.getItem(`run-events:${runId}`)!)).toHaveLength(12);
  });

  it("never shows an event twice, even when the server sends it again", async () => {
    const view = await showRun();
    await play(first.messages);
    await reload(view);
    // A server, or an older connection, that replays the run from the top.
    await play(events.slice(0, 12).map(asMessage));
    expect(
      screen.getAllByRole("region", { name: "Send this email?" }),
      "seq 1 to 12 came again and the timeline drew them twice: an event whose seq is already held changes nothing",
    ).toHaveLength(1);
    expect(rows("Looked up “Tom Whitfield”")).toHaveLength(1);
    expect(JSON.parse(sessionStorage.getItem(`run-events:${runId}`)!)).toHaveLength(12);
  });
});

describe("deciding", () => {
  it("sends Approve, and the card says Approved once the run's log does", async () => {
    await showRun();
    await play(first.messages);
    fireEvent.click(within(card()).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(decisions).toEqual([{ decision: "approved" }]));
    expect(within(card()).queryByText("Approved"), "the card can't know before the run says so").toBeNull();

    await play(second.messages);
    expect(within(card()).getByText("Approved")).toBeInTheDocument();
    expect(within(card()).queryByRole("button")).toBeNull();
    expect(screen.getByText("Sent")).toBeInTheDocument();
  });

  it("sends Reject", async () => {
    await showRun();
    await play(first.messages);
    fireEvent.click(within(card()).getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(decisions).toEqual([{ decision: "rejected" }]));
  });
});

describe("the worked example", () => {
  it("follows Leo's run: 12 events, a reload, ?after=12, the approval, 17 events each shown once", async () => {
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
    expect(first.messages.filter((m) => m.event === "token")).toHaveLength(41);
    expect(second.messages.filter((m) => m.event === "token")).toHaveLength(23);

    const view = await showRun();
    await play(first.messages);
    await reload(view);
    expect(FakeEventSource.last.url.slice(STREAM.length)).toBe("?after=12");
    expect(second.url).toBe(`${STREAM}?after=12`);

    fireEvent.click(within(card()).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(decisions).toHaveLength(1));
    await play(second.messages);

    expect(rows(DONE)).toHaveLength(1);
    expect(rows(DRAFT)).toHaveLength(1);
    // The badge at the top, and the status row at the end.
    expect(screen.getAllByText("Done")).toHaveLength(2);
    expect(JSON.parse(sessionStorage.getItem(`run-events:${runId}`)!)).toHaveLength(17);
    expect(FakeEventSource.last.closed, "the run is over, so its stream is closed").toBe(true);
  });
});
