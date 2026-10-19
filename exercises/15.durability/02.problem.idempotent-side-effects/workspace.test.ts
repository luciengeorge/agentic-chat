// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";

import { createWorkspaceWriter, WorkspaceWriteError } from "#learn/agent/tools/workspace";
import {
  GRACE_RUN,
  heldWorkspace,
  type HeldWorkspace,
  KESTREL_WORKSPACE_TOKEN,
  WORKSPACE_URL,
} from "@/core/agent/durable-testing";

const GRACE = GRACE_RUN.viewer.userId;
const TOM = "tom.whitfield@kestrelpay.example";
const KEY = "agent:067c2097-4255-43c5-8abd-293999f6d877:step_01M59S7YTACRNRD7B4V4Z4QEPV";
const mail = {
  to: [TOM],
  subject: "Payment terms: KPC-2026-0142",
  body: "The fixed platform fee is £61,400 per month, excluding VAT, invoiced monthly in advance.",
  attachments: [],
};

describe("posting a write with its idempotency key", () => {
  const open: HeldWorkspace[] = [];
  afterEach(async () => {
    for (const workspace of open.splice(0)) await workspace.close();
  });

  /** fake-workspace in process, and a writer for Kestrel's site whose waits are written down, not slept. */
  const setup = () => {
    const workspace = heldWorkspace();
    open.push(workspace);
    const waits: number[] = [];
    const writer = createWorkspaceWriter({
      baseUrl: WORKSPACE_URL,
      site: "kestrel",
      token: KESTREL_WORKSPACE_TOKEN,
      fetch: workspace.fetch,
      sleep: async (ms) => void waits.push(ms),
    });
    const sent = () => workspace.runtime.mailroom.sent;
    const fault = (spec: Record<string, unknown>) =>
      workspace.control("POST", "/faults", { path_prefix: "/v1.0/users", ...spec });
    return { workspace, writer, waits, sent, fault };
  };
  const send = (writer: ReturnType<typeof setup>["writer"], key = KEY, signal = new AbortController().signal) =>
    writer.sendMail(GRACE, mail, key, signal);

  it("sends the key as `Idempotency-Key`, and fake-workspace files the mail under it", async () => {
    const { workspace, writer, sent } = setup();
    await send(writer);
    expect(workspace.answers, "one request, answered 202, with the key it was handed as `idempotency-key`").toEqual([
      { key: KEY, status: 202, replayed: false },
    ]);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ idempotencyKey: KEY, to: [TOM], subject: mail.subject });
  });

  it("retries a 503 with the same key: two requests, one mail", async () => {
    const { workspace, writer, sent, fault } = setup();
    await fault({ kind: "error", status: 503, count: 1 });
    await send(writer);
    expect(
      workspace.answers.map((a) => a.key),
      "the retry must carry the same key: a new one is a new mail when the 503 came after the work",
    ).toEqual([KEY, KEY]);
    expect(workspace.answers.map((a) => a.status)).toEqual([503, 202]);
    expect(sent()).toHaveLength(1);
  });

  it("waits what Retry-After says, at most 10 s, and 250 ms then 500 ms when it says nothing", async () => {
    const said = setup();
    await said.fault({ kind: "throttle", retry_after_s: 3, count: 1 });
    await send(said.writer);
    expect(said.waits, "Retry-After is in seconds; the wait is in milliseconds").toEqual([3_000]);

    const tooLong = setup();
    await tooLong.fault({ kind: "throttle", retry_after_s: 30, count: 1 });
    await send(tooLong.writer);
    expect(tooLong.waits, "a tool call has 30 s in all: cap a wait at RETRY_AFTER_CAP_MS (10 s)").toEqual([10_000]);

    const silent = setup();
    await silent.fault({ kind: "error", status: 503, count: 2 });
    await send(silent.writer);
    expect(silent.waits, "no Retry-After: 250 ms × 2^attempt").toEqual([250, 500]);
    expect(silent.sent()).toHaveLength(1);
  });

  it("gives up after two retries, with the service's own error", async () => {
    const { workspace, writer, sent, fault } = setup();
    await fault({ kind: "error", status: 503 });
    const error = await send(writer).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkspaceWriteError);
    expect(error).toMatchObject({ status: 503, code: "serviceNotAvailable" });
    expect(workspace.answers, "maxRetries is 2: three requests in all").toHaveLength(3);
    expect(sent()).toHaveLength(0);
  });

  it("doesn't retry a refusal: a sender fake-workspace doesn't know is a 404, once", async () => {
    const { workspace, writer } = setup();
    const error = await writer
      .sendMail("9b2f6c1e-4a7d-4e2b-8c3f-1d5e6a7b8c9d", mail, KEY, new AbortController().signal)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 404, code: "itemNotFound", message: "No such user." });
    expect(workspace.answers, "a 404 fails the same way every time: one request").toHaveLength(1);
  });

  it("gets the first answer back for a key already done, and nothing is sent again", async () => {
    const { workspace, writer, sent } = setup();
    await send(writer);
    await send(writer);
    expect(workspace.answers.map((a) => a.replayed)).toEqual([false, true]);
    expect(sent()).toHaveLength(1);
  });

  it("sends one mail when the server dies mid-send and the step runs again: the kill proof, in miniature", async () => {
    const { workspace, writer, sent, fault } = setup();
    // As in the kill proof: the next send is held by a 15 s latency fault.
    await fault({ kind: "latency", latency_ms: 15_000, count: 1 });
    const dying = new AbortController();
    const first = send(writer, KEY, dying.signal).catch((e: unknown) => e);
    await expect.poll(() => workspace.waits()).toEqual([15]);
    // The server running the step is killed: its request has left, and its answer will never be read.
    dying.abort(new Error("SIGKILL"));
    expect(await first).toBeInstanceOf(Error);
    expect(sent(), "the held request hasn't reached the mailroom yet").toHaveLength(0);

    // The step runs again after the restart, with the key it had: it goes straight through.
    await send(writer);
    expect(sent()).toHaveLength(1);
    // Then the held request finishes inside fake-workspace, and finds its key already done.
    await workspace.release();
    expect(
      workspace.answers,
      "the held request should find its key already done and be replayed: every attempt sends the key it was handed",
    ).toEqual([
      { key: KEY, status: 202, replayed: false },
      { key: KEY, status: 202, replayed: true },
    ]);
    expect(sent(), "one mail for the key").toHaveLength(1);
    expect(sent()[0].idempotencyKey).toBe(KEY);
  });
});
