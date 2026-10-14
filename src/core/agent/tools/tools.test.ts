// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentTool } from "#learn/agent/types";
import type { Retrieve } from "#learn/retrieve/types";

import { runTool } from "#learn/agent/loop";
import { type Tx, withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

import { createApp, type Runtime } from "../../../../servers/fake-workspace/app";
import { buildCorpus, type Corpus, ManualClock } from "../../../../servers/fake-workspace/testing";
import { createAgentTools } from "./index";
import { createWorkspaceWriter, type Fetch } from "./workspace";

const DOC = { q3: "d0000000-0000-4000-8000-000000000001", heron: "d0000000-0000-4000-8000-000000000002" };
const PATH = { q3: "/Finance/Reports/Q3 report.pdf", heron: "/Exec/Project Heron memo.pdf" };

describe.skipIf(!postgresAvailable)("the agent's tools, as the viewer", () => {
  let t: TestDatabase;
  let tmp: string;
  let corpus: Corpus;
  let kestrel: string;
  let harbour: string;
  let workspace: Runtime;
  let app: { fetch: (request: Request) => Response | Promise<Response> };
  let fetch: ReturnType<typeof vi.fn<Fetch>>;
  let tools: AgentTool[];
  const retrieve = vi.fn<Retrieve>();

  const user = (name: string) => corpus.user("kestrel", name);
  const group = (path: string) => corpus.group("kestrel", path);
  const withTenant = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) => withTenantOn(t.appDb, tenantId, fn);
  const leo = () => ({ tenantId: kestrel, userId: user("leo.martin") });
  const run = (tool: string, input: unknown, callId = "c1", runId = "run-1") =>
    runTool({ callId, tool, input }, { tools, viewer: leo(), runId });
  const sent = () => workspace.mailroom.sent;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "agent-tools-"));
    corpus = buildCorpus(join(tmp, "corpus"));
    t = await createTestDatabase();
    [{ id: kestrel }, { id: harbour }] = await t.sql`
      INSERT INTO organization (name, slug, created_at)
      VALUES ('Kestrel Pay', 'kestrel', now()), ('Harbour Health', 'harbour', now()) RETURNING id`;

    const people: Array<[string, string, string, string, string | null, boolean]> = [
      [user("leo.martin"), "user", "leo.martin", "Leo Martin", "leo.martin@kestrelpay.example", true],
      [user("tom.whitfield"), "user", "tom.whitfield", "Tom Whitfield", "tom.whitfield@kestrelpay.example", true],
      [user("daniel.reyes"), "user", "daniel.reyes", "Daniel Reyes", "daniel.reyes@kestrelpay.example", true],
      [user("peter.hall"), "user", "peter.hall", "Peter Hall", "peter.hall@kestrelpay.example", false],
      [group("/Kestrel/Finance"), "group", "/Kestrel/Finance", "/Kestrel/Finance", null, true],
      [group("/Kestrel/Finance/AP"), "group", "/Kestrel/Finance/AP", "/Kestrel/Finance/AP", null, true],
      [group("/Kestrel/Exec"), "group", "/Kestrel/Exec", "/Kestrel/Exec", null, true],
    ];
    for (const [id, kind, name, display, email, enabled] of people) {
      await t.sql`INSERT INTO principals (id, tenant_id, kind, external_id, name, display_name, email, enabled, synced_at)
                  VALUES (${id}, ${kestrel}, ${kind}, ${id}, ${name}, ${display}, ${email}, ${enabled}, now())`;
    }
    const nina = corpus.user("harbour", "nina.osei");
    await t.sql`INSERT INTO principals (id, tenant_id, kind, external_id, name, display_name, email, enabled, synced_at)
                VALUES (${nina}, ${harbour}, 'user', ${nina}, 'nina.osei', 'Nina Osei', 'nina.osei@harbourhealth.example', true, now())`;
    for (const [groupId, memberId, depth] of [
      [group("/Kestrel/Finance/AP"), user("leo.martin"), 1],
      [group("/Kestrel/Finance"), user("leo.martin"), 2],
      [group("/Kestrel/Finance"), group("/Kestrel/Finance/AP"), 1],
      [group("/Kestrel/Finance"), user("tom.whitfield"), 1],
      [group("/Kestrel/Exec"), user("daniel.reyes"), 1],
    ] as const) {
      await t.sql`INSERT INTO group_closure (tenant_id, group_id, member_id, depth)
                  VALUES (${kestrel}, ${groupId}, ${memberId}, ${depth})`;
    }

    for (const [key, grantee] of [
      ["q3", group("/Kestrel/Finance")],
      ["heron", group("/Kestrel/Exec")],
    ] as const) {
      const path = PATH[key];
      await t.sql`INSERT INTO documents (id, tenant_id, source, external_id, title, path, mime_type, version,
                    source_version, content_hash, status, acl_version)
                  VALUES (${DOC[key]}, ${kestrel}, 'workspace', ${corpus.id("kestrel", path)}, ${path.split("/").at(-1)!},
                    ${path}, 'application/pdf', 2, '2', ${key}, 'ready', 1)`;
      await t.sql`INSERT INTO document_acl (tenant_id, document_id, principal_id, effect, acl_version)
                  VALUES (${kestrel}, ${DOC[key]}, ${grantee}, 'allow', 1)`;
      // A stale version's chunk, which a read must skip.
      await t.sql`INSERT INTO chunks (tenant_id, document_id, document_version, ordinal, text, token_count)
                  VALUES (${kestrel}, ${DOC[key]}, 1, 0, 'old text', 2)`;
      for (let ordinal = 0; ordinal < 5; ordinal++) {
        await t.sql`INSERT INTO chunks (tenant_id, document_id, document_version, ordinal, text, section, page_start, page_end, token_count)
                    VALUES (${kestrel}, ${DOC[key]}, 2, ${ordinal * 10}, ${`${key} part ${ordinal}`}, 'Summary', 1, 1, 1000)`;
      }
    }
  });

  afterAll(async () => {
    await t?.drop();
    rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(() => {
    ({ app, runtime: workspace } = createApp({
      env: "dev",
      corpusDir: corpus.dir,
      worldPath: corpus.worldPath,
      clock: new ManualClock(),
    }));
    fetch = vi.fn<Fetch>(async (url, init) => app.fetch(new Request(url, init)));
    retrieve.mockReset();
    tools = createAgentTools({
      withTenant,
      retrieve,
      workspace: async () =>
        createWorkspaceWriter({
          baseUrl: "http://fw",
          site: "kestrel",
          token: "dev-workspace-kestrel",
          fetch,
          sleep: async () => {},
        }),
    });
  });

  describe("search_documents", () => {
    it("retrieves as the viewer, at most 8, and returns the passages with their ids", async () => {
      retrieve.mockResolvedValue({
        query: "q3",
        rewritten: [],
        auditId: "a",
        chunks: [
          {
            id: "c-1",
            documentId: DOC.q3,
            title: "Q3 report.pdf",
            path: PATH.q3,
            text: "Revenue rose.",
            pageStart: 2,
            pageEnd: 2,
            section: null,
            score: 0.9,
          },
        ],
      });
      expect(await run("search_documents", { query: "q3 revenue", k: null })).toEqual({
        type: "tool_result",
        callId: "c1",
        ok: true,
        output: {
          passages: [
            {
              chunkId: "c-1",
              documentId: DOC.q3,
              title: "Q3 report.pdf",
              path: PATH.q3,
              pageStart: 2,
              pageEnd: 2,
              text: "Revenue rose.",
            },
          ],
        },
      });
      expect(retrieve).toHaveBeenCalledWith(leo(), "q3 revenue", { k: 8 });
      expect(await run("search_documents", { query: "x", k: 9 })).toMatchObject({ ok: false });
    });
  });

  describe("read_document", () => {
    it("reads the current version in order, up to the token cap, and pages on", async () => {
      const first = await run("read_document", { documentId: DOC.q3, fromChunk: null });
      expect(first).toMatchObject({
        ok: true,
        output: { title: "Q3 report.pdf", path: PATH.q3, nextChunk: 3 },
      });
      const texts = (r: typeof first) =>
        r.ok ? (r.output as { chunks: { text: string }[] }).chunks.map((c) => c.text) : [];
      expect(texts(first)).toEqual(["q3 part 0", "q3 part 1", "q3 part 2"]);
      const rest = await run("read_document", { documentId: DOC.q3, fromChunk: 3 });
      expect(texts(rest)).toEqual(["q3 part 3", "q3 part 4"]);
      expect(rest).toMatchObject({ output: { nextChunk: null } });
    });

    it("refuses a document the viewer can't read exactly as one that doesn't exist", async () => {
      const heron = await run("read_document", { documentId: DOC.heron, fromChunk: null });
      const missing = await run("read_document", {
        documentId: "d0000000-0000-4000-8000-0000000000ff",
        fromChunk: null,
      });
      expect(heron).toEqual({
        type: "tool_result",
        callId: "c1",
        ok: false,
        error: `No document ${DOC.heron} that you can read.`,
      });
      expect(missing).toMatchObject({
        ok: false,
        error: expect.stringMatching(/^No document .* that you can read\.$/),
      });
    });
  });

  describe("find_person", () => {
    it("finds people by name or email in the viewer's tenant, and never a disabled one", async () => {
      const find = async (query: string) => {
        const r = await run("find_person", { query });
        return r.ok ? (r.output as { people: { name: string }[] }).people.map((p) => p.name) : r.error;
      };
      expect(await find("whitf")).toEqual(["Tom Whitfield"]);
      expect(await find("leo.martin@")).toEqual(["Leo Martin"]);
      expect(await find("finance")).toEqual(["/Kestrel/Finance", "/Kestrel/Finance/AP"]);
      expect(await find("peter")).toEqual([]);
      expect(await find("nina")).toEqual([]);
      expect(await find("%_")).toEqual([]);
    });
  });

  describe("send_mail", () => {
    const mail = (attachmentDocumentIds: string[] = []) => ({
      to: ["tom.whitfield@kestrelpay.example"],
      subject: "Q3",
      body: "Here it is.",
      attachmentDocumentIds,
    });

    it("sends as the viewer with the documents attached by their drive ids", async () => {
      expect(await run("send_mail", mail([DOC.q3]))).toMatchObject({
        ok: true,
        output: { sent: true, attachments: ["Q3 report.pdf"] },
      });
      expect(sent()).toMatchObject([
        {
          from: { id: user("leo.martin") },
          to: ["tom.whitfield@kestrelpay.example"],
          attachments: [{ itemId: corpus.id("kestrel", PATH.q3) }],
          idempotencyKey: "agent:run-1:c1",
        },
      ]);
    });

    it("refuses an attachment the viewer can't read before anything leaves", async () => {
      expect(await run("send_mail", mail([DOC.q3, DOC.heron]))).toEqual({
        type: "tool_result",
        callId: "c1",
        ok: false,
        error: `No document ${DOC.heron} that you can read.`,
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(sent()).toEqual([]);
    });

    it("sends once for one call, however often it's retried; another call sends again", async () => {
      await run("send_mail", mail(), "c1");
      await run("send_mail", mail(), "c1");
      expect(sent()).toHaveLength(1);
      expect(fetch).toHaveBeenCalledTimes(2);
      await run("send_mail", mail(), "c2");
      expect(sent()).toHaveLength(2);
    });

    it("retries a throttled or failed send with the same key, and sends once", async () => {
      workspace.faults.add({
        site: null,
        kind: "throttle",
        path_prefix: "/v1.0/users",
        after_requests: 0,
        count: 1,
        retry_after_s: 1,
        status: 503,
        latency_ms: null,
      });
      workspace.faults.add({
        site: null,
        kind: "error",
        path_prefix: "/v1.0/users",
        after_requests: 0,
        count: 1,
        retry_after_s: null,
        status: 502,
        latency_ms: null,
      });
      expect(await run("send_mail", mail())).toMatchObject({ ok: true });
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(new Set(fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("idempotency-key")))).toEqual(
        new Set(["agent:run-1:c1"]),
      );
      expect(sent()).toHaveLength(1);
    });

    it("needs the user's approval", () => {
      const send = tools.find((tool) => tool.name === "send_mail")!;
      expect(send.effect).toBe("write");
      expect(send.needsApproval(mail(), undefined as never)).toBe(true);
    });
  });

  describe("share_document", () => {
    it("grants the recipient read access on the drive item", async () => {
      const result = await run("share_document", {
        documentId: DOC.q3,
        recipientId: user("daniel.reyes"),
        role: "read",
      });
      expect(result).toMatchObject({
        ok: true,
        output: { shared: true, title: "Q3 report.pdf", recipient: "Daniel Reyes" },
      });
      const site = workspace.workspace.sites.get("kestrel")!;
      const grants = site.effective(site.get(corpus.id("kestrel", PATH.q3))).map((e) => e.grant.principal_id);
      expect(grants).toContain(user("daniel.reyes"));
      expect(fetch.mock.calls[0][0]).toBe(
        `http://fw/v1.0/drives/kestrel/items/${corpus.id("kestrel", PATH.q3)}/invite`,
      );
    });

    it("refuses an unreadable document, a disabled recipient and another tenant's", async () => {
      const share = (documentId: string, recipientId: string) =>
        run("share_document", { documentId, recipientId, role: "read" });
      expect(await share(DOC.heron, user("tom.whitfield"))).toMatchObject({
        ok: false,
        error: expect.stringContaining("No document"),
      });
      expect(await share(DOC.q3, user("peter.hall"))).toMatchObject({
        ok: false,
        error: expect.stringContaining("No person"),
      });
      expect(await share(DOC.q3, corpus.user("harbour", "nina.osei"))).toMatchObject({ ok: false });
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
