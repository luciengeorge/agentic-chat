// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { RunEvent } from "#learn/agent/types";
import type { ChatMessage } from "#learn/model/types";

import { AGENT_INSTRUCTIONS, buildContext, eventGroups, messageTokens } from "#learn/agent/context";
import { recordedEvents } from "@/core/agent/state-testing";

const tokens = (messages: readonly ChatMessage[]) => messages.reduce((sum, m) => sum + messageTokens(m), 0);
const roles = (messages: readonly ChatMessage[]) => messages.map((m) => m.role).join(" ");
/** Every tool message comes right after its call's assistant turn or a sibling result: what the model APIs need. */
function orphans(messages: readonly ChatMessage[]): string[] {
  const open = new Set<string>();
  const found: string[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      open.clear();
      for (const call of m.toolCalls ?? []) open.add(call.callId);
    } else if (m.role === "tool") {
      if (!open.has(m.callId)) found.push(m.callId);
    } else open.clear();
  }
  return found;
}

const kpc = recordedEvents("kpc-email");
const NOTE = "I prefer answers as short bullet points.";

describe("folding events into turns", () => {
  it("makes the user's message a turn, and each assistant turn a group with its calls' results", () => {
    const groups = eventGroups(recordedEvents("kpc-email", 9));
    expect(
      groups.map((g) => g.map((m) => m.role)),
      "seq 1 is Leo's message; 3+4, 5+6+7 and 8+9 are turns with their results; status moves add nothing",
    ).toEqual([["user"], ["assistant", "tool"], ["assistant", "tool", "tool"], ["assistant", "tool"]]);
    const [user, plan, search] = groups;
    expect(user[0]).toEqual({ role: "user", content: kpc[0].data.type === "user_message" ? kpc[0].data.text : "" });
    expect(plan[0], "the call goes to the model as { callId, name, input }").toMatchObject({
      role: "assistant",
      content: "",
      toolCalls: [{ callId: "call_iTQ9G6G7RvJD9R9xBiDsgb8e", name: "make_plan" }],
    });
    expect(plan[1]).toEqual({
      role: "tool",
      callId: "call_iTQ9G6G7RvJD9R9xBiDsgb8e",
      toolName: "make_plan",
      output: { planned: 1 },
    });
    expect(
      search.slice(1).map((m) => m.role === "tool" && m.toolName),
      "a result is named for its call's tool",
    ).toEqual(["search_documents", "find_person"]);
  });

  it("gives an assistant turn with no calls no toolCalls field, and flags a failed result as an error", () => {
    const [[turn]] = eventGroups(recordedEvents("kpc-email").filter((e) => e.seq === 16));
    expect(turn).toEqual({
      role: "assistant",
      content: "Emailed Tom Whitfield the two-line summary of payment terms in KPC-2026-0142.",
    });
    const failed = eventGroups([
      ...kpc.filter((e) => e.seq === 3),
      { ...kpc[3], data: { type: "tool_result", callId: "call_iTQ9G6G7RvJD9R9xBiDsgb8e", ok: false, error: "boom" } },
    ]);
    expect(failed[0][1], "a failed result's output is its error, marked isError").toEqual({
      role: "tool",
      callId: "call_iTQ9G6G7RvJD9R9xBiDsgb8e",
      toolName: "make_plan",
      output: "boom",
      isError: true,
    });
  });

  it("leaves out a result whose call isn't in the events (it was compacted away)", () => {
    // The lost-plan run from seq 14: the read_document result at 14 answers a call made at 13.
    const groups = eventGroups(recordedEvents("lost-plan", 16).filter((e) => e.seq >= 14));
    expect(
      groups.map((g) => g.map((m) => m.role)),
      "seq 14's call is gone, so seq 14 must go too",
    ).toEqual([["assistant", "tool"]]);
  });

  it("tells the model a rejected write never ran", () => {
    // Tom's run waited on send_mail at seq 8; the cancel rejected the approval at seq 10 and no result was written.
    const groups = eventGroups(recordedEvents("cancel-waiting"));
    expect(groups.at(-1), "a rejected approval with no result needs an error result in its call's group").toEqual([
      expect.objectContaining({ role: "assistant", toolCalls: [expect.objectContaining({ name: "send_mail" })] }),
      {
        role: "tool",
        callId: "call_SXBJAa3SYwee5EzzoxKGsKuh",
        toolName: "send_mail",
        output: "The user rejected this action.",
        isError: true,
      },
    ]);
    const expired = recordedEvents("cancel-waiting").map((e): RunEvent =>
      e.data.type === "approval_decided" ? { ...e, data: { ...e.data, decision: "expired", by: null } } : e,
    );
    expect(eventGroups(expired).at(-1)?.[1]).toMatchObject({ output: "The approval expired before anyone answered." });
    const answered = [
      ...recordedEvents("cancel-waiting"),
      {
        ...kpc[3],
        seq: 12,
        data: {
          type: "tool_result" as const,
          callId: "call_SXBJAa3SYwee5EzzoxKGsKuh",
          ok: false as const,
          error: "Declined",
        },
      },
    ];
    expect(eventGroups(answered).at(-1)?.slice(1), "a call the loop already answered gets no second result").toEqual([
      expect.objectContaining({ output: "Declined" }),
    ]);
  });
});

describe("building the context", () => {
  it("keeps the newest whole turns that fit the budget, and never a result without its call", () => {
    const context = buildContext(kpc, 4_000);
    expect(orphans(context.messages), "a turn and its results are kept or dropped together").toEqual([]);
    expect(context.messages[0], "the oldest kept message is the read_document turn of seq 8").toMatchObject({
      role: "assistant",
      toolCalls: [{ name: "read_document" }],
    });
    expect(tokens(context.messages), "2,627 tokens fit; the search turn (2,121 more) would make 4,748").toBe(2_627);
  });

  it("stops at the first turn that doesn't fit, and always keeps the newest", () => {
    // Over 4,000 the search turn (2,121) doesn't fit, but the plan turn (108) and Leo's message (27) would.
    const context = buildContext(kpc, 4_000);
    expect(
      context.messages.some((m) => m.role === "user"),
      "an older, smaller turn mustn't be kept once a newer one was dropped: the history would have a hole",
    ).toBe(false);
    expect(roles(buildContext(kpc, 10).messages), "the newest turn stays even when it alone is over budget").toBe(
      "assistant",
    );
  });

  it("starts from the latest compaction: its summary first, then only the events after what it covers", () => {
    const events = recordedEvents("lost-plan", 17);
    const context = buildContext(events);
    const compaction = events.at(-1)!.data;
    expect(compaction.type).toBe("compaction");
    expect(context.messages[0], "the summary goes first, as a user turn in a <summary> tag").toEqual({
      role: "user",
      content: `<summary>\nWhat happened earlier in this run, summarised:\n${compaction.type === "compaction" ? compaction.summary : ""}\n</summary>`,
    });
    expect(
      roles(context.messages),
      "seq 1 to 12 are in the summary: replay 13 to 16 only (two turns with their results)",
    ).toBe("user assistant tool assistant tool");
  });

  it("comes out the same however the log was read", () => {
    const events = recordedEvents("lost-plan");
    expect(buildContext([...events].reverse()), "sort by seq first").toEqual(buildContext(events));
  });

  it("puts the user's notes after the instructions, and gives the planning turn the user's messages only", () => {
    const context = buildContext(kpc.slice(0, 1), undefined, { notes: [NOTE] });
    expect(context.instructions.startsWith(AGENT_INSTRUCTIONS)).toBe(true);
    expect(context.instructions, "notes go after the instructions, as data (notesBlock)").toContain(`- ${NOTE}`);
    expect(context.planning, "the newest message is Leo's: add the planning view").toBeDefined();
    expect(context.planning!.messages).toEqual([context.messages[0]]);
    expect(context.planning!.instructions, "the planning turn never sees the notes").not.toContain(NOTE);
    expect(buildContext(kpc).planning, "after the model answered, there's no planning view").toBeUndefined();
    expect(buildContext(recordedEvents("lost-plan", 17)).planning, "a summary isn't the user speaking").toBeUndefined();
  });

  describe("the worked example", () => {
    it("rebuilds Leo's run as 11 messages and 4,883 tokens, and 2,627 tokens in 5 messages at a budget of 4,000", () => {
      const full = buildContext(kpc);
      expect(roles(full.messages)).toBe(
        "user assistant tool assistant tool tool assistant tool assistant tool assistant",
      );
      expect(tokens(full.messages)).toBe(4_883);
      const tight = buildContext(kpc, 4_000);
      expect(tight.messages).toHaveLength(5);
      expect(tokens(tight.messages)).toBe(2_627);
    });

    it("shrinks the lost-plan run from 15 messages and 15,675 tokens to 5 and 5,630 once its compaction lands", () => {
      const before = buildContext(recordedEvents("lost-plan", 16));
      expect([before.messages.length, tokens(before.messages)]).toEqual([15, 15_675]);
      const after = buildContext(recordedEvents("lost-plan", 17));
      expect([after.messages.length, tokens(after.messages)]).toEqual([5, 5_630]);
    });
  });
});
