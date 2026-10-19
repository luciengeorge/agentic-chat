// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { Retrieve } from "#learn/retrieve/types";

import { runTool } from "#learn/agent/loop";
import { createAgentTools } from "#learn/agent/tools/index";
import { createWorkspaceWriter, type Fetch } from "#learn/agent/tools/workspace";
import { setupAclWorld } from "@/core/acl/testing";
import { KESTREL_TOKEN, REAL_BASE_URL, setupRealWorkspace } from "@/core/connectors/testing";
import { type Tx, withTenantOn } from "@/db/tenant";

const Q3 = "/Finance/Reports/Q3 2026 Quarterly Report.pdf";
const HERON = "/Exec/Project Heron Board Memo.pdf";
const TOM = "tom.whitfield@kestrelpay.example";
const MADE_UP = "9b2f6c1e-4a7d-4e2b-8c3f-1d5e6a7b8c9d";

const world = setupAclWorld();
const workspaces = setupRealWorkspace();

/** The app's tools as grace.adeyemi, writing to an in-process fake-workspace; every request it gets is counted. */
function asGrace() {
  const w = world.get();
  const workspace = workspaces.start();
  const requests: string[] = [];
  const fetch: Fetch = async (url, init) => {
    requests.push(`${init?.method ?? "GET"} ${new URL(String(url)).pathname}`);
    return workspace.fetch(url, init);
  };
  const nothing: Retrieve = async (_viewer, query) => ({ query, rewritten: [], auditId: "", chunks: [] });
  const tools = createAgentTools({
    withTenant: <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) => withTenantOn(w.t.appDb, tenantId, fn),
    retrieve: nothing,
    workspace: async () =>
      createWorkspaceWriter({
        baseUrl: REAL_BASE_URL,
        site: "kestrel",
        token: KESTREL_TOKEN,
        fetch,
        sleep: async () => {},
      }),
  });
  const viewer = { tenantId: w.tenants.kestrel, userId: w.user("grace.adeyemi") };
  const run = (tool: string, input: unknown, callId = "c1") =>
    runTool({ callId, tool, input }, { tools, viewer, runId: "run-1" });
  return { w, run, requests, mail: workspace.runtime.mailroom.sent, invites: workspace.runtime.invites.done };
}

const mail = (attachmentDocumentIds: string[]) => ({
  to: [TOM],
  subject: "Q3",
  body: "The Q3 report, as promised.",
  attachmentDocumentIds,
});

describe("send_mail, as the user", () => {
  it("mails Tom the Q3 report as Grace, with its drive item and the call's key", async () => {
    const { w, run, mail: sent } = asGrace();
    const q3 = await w.documentId(Q3);
    expect(await run("send_mail", mail([q3]))).toEqual({
      type: "tool_result",
      callId: "c1",
      ok: true,
      output: { sent: true, to: [TOM], subject: "Q3", attachments: ["Q3 2026 Quarterly Report.pdf"] },
    });
    expect(sent).toMatchObject([
      {
        from: { id: w.user("grace.adeyemi") },
        to: [TOM],
        attachments: [{ itemId: w.itemId(Q3), name: "Q3 2026 Quarterly Report.pdf" }],
        idempotencyKey: "agent:run-1:c1",
      },
    ]);
  });

  it("refuses the Heron memo, which Grace can't read, before anything leaves", async () => {
    const { w, run, requests, mail: sent } = asGrace();
    const heron = await w.documentId(HERON);
    expect(
      await run("send_mail", mail([await w.documentId(Q3), heron])),
      "Grace can't read the Heron memo: canRead as Grace, and notReadable's words",
    ).toEqual({
      type: "tool_result",
      callId: "c1",
      ok: false,
      error: `No document ${heron} that you can read.`,
    });
    expect(requests, "checked before sending: nothing reached fake-workspace").toEqual([]);
    expect(sent).toEqual([]);
  });

  it("refuses a made-up id in the same words, so a refusal never says a document exists", async () => {
    const { w, run } = asGrace();
    const heron = await w.documentId(HERON);
    const forbidden = await run("send_mail", mail([heron]));
    const missing = await run("send_mail", mail([MADE_UP]));
    expect(missing, "notReadable's words for an id nobody used").toMatchObject({
      ok: false,
      error: `No document ${MADE_UP} that you can read.`,
    });
    expect(
      JSON.stringify(forbidden).replace(heron, "<id>"),
      "the Heron memo's refusal and a made-up id's must read the same",
    ).toBe(JSON.stringify(missing).replace(MADE_UP, "<id>"));
  });

  it("sends once for one call, however often it's retried", async () => {
    const { w, run, mail: sent } = asGrace();
    const q3 = await w.documentId(Q3);
    await run("send_mail", mail([q3]), "c1");
    await run("send_mail", mail([q3]), "c1");
    expect(sent, "the call's idempotency key goes with the mail, so a retry is a replay").toHaveLength(1);
    await run("send_mail", mail([q3]), "c2");
    expect(sent).toHaveLength(2);
  });
});

describe("share_document, as the user", () => {
  it("shares the Q3 report with Tom, acting as Grace", async () => {
    const { w, run, invites } = asGrace();
    const q3 = await w.documentId(Q3);
    expect(await run("share_document", { documentId: q3, recipientId: w.user("tom.whitfield"), role: "read" })).toEqual(
      {
        type: "tool_result",
        callId: "c1",
        ok: true,
        output: {
          shared: true,
          documentId: q3,
          title: "Q3 2026 Quarterly Report.pdf",
          recipient: "Tom Whitfield",
          role: "read",
        },
      },
    );
    expect(invites).toMatchObject([
      { itemId: w.itemId(Q3), recipients: [w.user("tom.whitfield")], idempotencyKey: "agent:run-1:c1" },
    ]);
    expect(invites[0].by, "the drive checks the acting user, so it must be Grace").toBe(w.user("grace.adeyemi"));
  });

  it("refuses the Heron memo, Nina at Harbour and a colleague who has left, and sends nothing", async () => {
    const { w, run, requests, invites } = asGrace();
    const q3 = await w.documentId(Q3);
    const heron = await w.documentId(HERON);
    const nina = w.user("nina.osei", "harbour");
    const peter = w.user("peter.hall");
    expect(
      await run("share_document", { documentId: heron, recipientId: w.user("tom.whitfield"), role: "read" }),
      "Grace can't read the Heron memo, so she can't share it",
    ).toEqual({ type: "tool_result", callId: "c1", ok: false, error: `No document ${heron} that you can read.` });
    expect(await run("share_document", { documentId: q3, recipientId: nina, role: "read" })).toEqual({
      type: "tool_result",
      callId: "c1",
      ok: false,
      error: `No person or group ${nina} in your organisation's directory.`,
    });
    expect(
      await run("share_document", { documentId: q3, recipientId: peter, role: "read" }),
      "peter.hall is disabled: only enabled people and groups of the tenant",
    ).toEqual({
      type: "tool_result",
      callId: "c1",
      ok: false,
      error: `No person or group ${peter} in your organisation's directory.`,
    });
    expect(requests, "every refusal happens before fake-workspace is asked").toEqual([]);
    expect(invites).toEqual([]);
  });
});
